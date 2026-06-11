// AdBolt check-in snapshot: load a publisher page, bake the creative into real
// ad slots, then serialize the whole page into ONE self-contained HTML file
// (every asset inlined) via SingleFile. The result is a permanent, scrollable,
// layout-accurate preview with the ad in context — served read-only at
// /preview/snapshot.html?id=<id> and shareable with clients.
//
// Replaces the old live-stream + draggable-overlay flow as the visualization.
//
// Runtime: Node (Chromium can't run on edge). Auth: Supabase user JWT (Bearer).

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { createClient } from '@supabase/supabase-js';
import { script as SINGLEFILE_BUNDLE } from 'single-file-cli/lib/single-file-bundle.js';
import {
  bakeCreativeInPage,
  cleanOverlaysInPage,
  autoScrollInPage,
  dismissConsentInPage,
} from './_checkin/engine.js';
import { resolveHyprAdtagEmbedUrl } from './_checkin/live.js';

export const config = { maxDuration: 180 };

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://adfnabuwzmojxbhcpdpe.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkZm5hYnV3em1vanhiaGNwZHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MTcxODcsImV4cCI6MjA5MTA5MzE4N30.sU9EZAnQ2mClIsMwfccR5__nbTYnfzkt3IvP-llxpno';

const NAV_TIMEOUT = 45_000;
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY || '';
const BROWSERBASE_PROJECT_ID =
  process.env.BROWSERBASE_PROJECT_ID || '3798efe6-2de2-4c29-81cc-4bb9d4af54bc';

// Hosts that inject login/consent overlays we never want in a deliverable.
const BLOCK_URL_RX = /accounts\.google\.com\/gsi|gsi\/client|onetag\.|cmp\.|cookielaw\.org\/consent|onetrust\.com\/.*banner/i;

// ---------------------------------------------------------------------------
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

async function launchEmbedded() {
  chromium.setGraphicsMode = false;
  return puppeteer.launch({
    args: [...chromium.args, '--disable-blink-features=AutomationControlled'],
    executablePath: await chromium.executablePath(),
    headless: true,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });
}

async function createBrowserbaseSession(proxies) {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': BROWSERBASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BROWSERBASE_PROJECT_ID,
      proxies: proxies ? [{ type: 'browserbase', geolocation: { country: 'BR' } }] : false,
      browserSettings: { viewport: { width: 1440, height: 900 } },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`browserbase session ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function acquireBrowser({ proxies }) {
  if (BROWSERBASE_API_KEY) {
    const session = await createBrowserbaseSession(proxies);
    const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl, defaultViewport: null });
    const page = (await browser.pages())[0] || (await browser.newPage());
    return { browser, page, engine: 'browserbase', cleanup: () => browser.close().catch(() => {}) };
  }
  const browser = await launchEmbedded();
  const page = await browser.newPage();
  return { browser, page, engine: 'embedded', cleanup: () => browser.close().catch(() => {}) };
}

// ---------------------------------------------------------------------------
// Fetch the creative server-side (no CORS) and turn it into a self-contained
// data: URI. Baking the creative as a URL fails on strict publishers: SingleFile
// runs inside the publisher page and its cross-origin fetch of our signed
// asset-uploads URL is blocked by CORS / the page CSP, leaving the slot blank.
// A data: URI renders everywhere and needs no fetch.
function sniffImageMime(buf, fallback) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf.length >= 12 &&
        buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  const head = buf.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.includes('<svg')) return 'image/svg+xml';
  return fallback || 'image/png';
}

async function creativeToDataUri(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`creative fetch ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('creative empty');
  if (buf.length > 12 * 1024 * 1024) throw new Error('creative too large (>12MB)');
  const hdr = (r.headers.get('content-type') || '').toLowerCase();
  const mime = hdr.startsWith('image/') && !hdr.includes('octet')
    ? hdr.split(';')[0]
    : sniffImageMime(buf, 'image/png');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Lazy sharp: present on Vercel (declared dep), optional elsewhere — the bridge
// degrades to pass-through when unavailable.
let _sharp;
async function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try { _sharp = (await import('sharp')).default; } catch (e) { _sharp = null; }
  return _sharp;
}

// Recompress large raster images before shipping them through the CDP websocket
// into the page. The bridge payload (base64 in JSON CDP messages over ONE remote
// websocket) is the dominant serialize cost on image-heavy publishers; a 1280px
// webp q70 cut is invisible in an ad-in-context preview but cuts the wire bytes
// (and the final snapshot HTML) 3-5x. GIF (animation) and SVG are passed through.
const DOWNSCALE_MIN_BYTES = 150 * 1024;
async function maybeDownscaleImage(buf, contentType) {
  if (!buf || buf.length < DOWNSCALE_MIN_BYTES) return { buf, contentType };
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(contentType)) return { buf, contentType };
  const sharp = await getSharp();
  if (!sharp) return { buf, contentType };
  try {
    const out = await sharp(buf).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    if (out.length < buf.length * 0.9) return { buf: out, contentType: 'image/webp' };
  } catch (e) { /* corrupt/unsupported image — keep original */ }
  return { buf, contentType };
}

// Fetch a page resource (image/css/font) in Node — no CORS, not subject to the
// publisher's CSP. SingleFile runs inside the page and its in-page fetch of
// cross-origin assets (publisher CDN images, fonts) is blocked, leaving the
// page's own images blank. Exposed to the page as window.__adboltFetch so
// SingleFile can inline everything through Node instead.
//
// `cache` is the response cache populated DURING page load (see runSnapshot):
// a hit skips the refetch entirely — the browser→Node transfer already happened
// overlapped with nav/scroll wait time instead of serially during serialize.
async function nodeFetchResource(url, cache) {
  try {
    if (!/^https?:/i.test(url)) return { status: 0, base64: '', headers: {} };
    const hit = cache && cache.get(url);
    if (cache) {
      const st = cache.__stats || (cache.__stats = { hit: 0, miss: 0, missUrls: [] });
      if (hit) st.hit++; else { st.miss++; if (st.missUrls.length < 25) st.missUrls.push(url.slice(0, 120)); }
    }
    if (hit) {
      // Served as cached — the downscale (if applicable) already ran at
      // cache-fill time, overlapped with page load. Never encode here: this is
      // the serialize critical path.
      return { status: 200, base64: hit.buf.toString('base64'), headers: { 'content-type': hit.contentType } };
    }
    // Bound every asset fetch: a single slow/hanging publisher resource (tracker,
    // slow CDN) with no timeout was stalling the whole SingleFile serialize for
    // tens of seconds. 4s is plenty for a real asset; anything slower is skipped.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    let r;
    try { r = await fetch(url, { redirect: 'follow', signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return { status: 0, base64: '', headers: {} }; // skip huge assets
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    return {
      status: r.status,
      base64: buf.toString('base64'),
      headers: { 'content-type': ct || '' },
    };
  } catch (e) {
    return { status: 0, base64: '', headers: {} };
  }
}

// Resolve a CM360 placement to the real creative image URL via the ad server's
// /ddm/adi endpoint (same approach as api/ad-proxy.js) — works regardless of the
// tag's client-side render mode and without running dcmads.js.
async function resolveCm360Image(placement, w, h) {
  if (!/^[A-Za-z0-9._/-]+$/.test(placement)) return null;
  const ord = String(Math.floor(Math.random() * 1e13));
  const adUrl = `https://ad.doubleclick.net/ddm/adi/${placement};sz=${w}x${h};ord=${ord}?`;
  try {
    const r = await fetch(adUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const html = await r.text();
    const img = html.match(/https:\/\/s0\.2mdn\.net\/simgad\/\d+/);
    const rich = html.match(/https:\/\/s0\.2mdn\.net\/creatives\/[A-Za-z0-9_\-/]+\.(?:png|jpg|jpeg|gif|webp)/i);
    return img ? img[0] : (rich ? rich[0] : null);
  } catch (e) {
    return null;
  }
}

// Screenshot a headless page region into a PNG data URI.
async function shotToDataUri(page, w, h) {
  await new Promise((r) => setTimeout(r, 2200)); // let the creative settle to a frame
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
  return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
}

// Kinds that CAN carry a live layer over the frozen image. The live layer is
// only attached when resolveLive() returns a concrete embed for the creative —
// the kind being in this set is necessary but not sufficient.
//   • html5  → hosted bundle URL, framed live
//   • survey → resolved embed URL (Typeform widget / generic iframe), framed live
//   • video  → playable asset URL (mp4), native <video controls>
//   • tag    → ONLY HYPR AdTags (data-hypr-adtag): the hosted creative URL in
//              data-iframe-src is framed bare. hypr-adtag.js gates impressions/
//              events behind a delivery URL param (dlv=...), so the bare share
//              URL fires NO billable beacons — same rationale as the Typeform
//              direct-iframe path. Other 3P adserver tags (CM360, Xandr, DV360)
//              stay frozen: rendering a real serving tag fires billable
//              impressions/clicks and would pollute the very delivery this
//              preview certifies. Interactive preview for those is a follow-up
//              that must use each DSP's non-billable preview/render endpoint.
// 'display' is always the frozen image.
const LIVE_KINDS = new Set(['html5', 'survey', 'video', 'tag']);

// Strip the publisher's own CSP <meta> tags from the serialized HTML. They
// survive SingleFile and would block both the injected hydrator script and the
// live <iframe> (frame-src/script-src). Safe to drop in a static deliverable.
function stripCspMeta(html) {
  return html.replace(
    /<meta[^>]*http-equiv\s*=\s*['"]?content-security-policy(?:-report-only)?['"]?[^>]*>/gi,
    ''
  );
}

// Resolve a survey creative (a stored embed snippet) to a single framable https
// URL. Runs in Node, so parsing is done here once — deterministically — instead
// of regex-sniffing inside the client hydrator (which is exactly what used to
// silently break: a mis-escaped regex left every Typeform survey frozen).
// Handles the three shapes a survey embed arrives in:
//   1. <iframe src="https://…">            → use the src
//   2. Typeform data-tf-live/-widget="ID"   → build form.typeform.com/to/ID
//   3. a bare https://…typeform.com/to/ID   → use it directly
// As a last resort, any https URL in the snippet. Typeform standalone /to/ URLs
// stall on a loading screen unless told they're an embed, so the embed flag is
// appended for any typeform.com URL.
function resolveSurveyEmbedUrl(html) {
  const src = String(html || '');
  if (!src) return null;
  let url = null;

  const iframe = src.match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  if (iframe && /^https?:\/\//i.test(iframe[1])) url = iframe[1];

  if (!url) {
    const tf = src.match(/data-tf-(?:live|widget|popup|slider|popover|sidetab)\s*=\s*["']([A-Za-z0-9]+)["']/i);
    if (tf) url = `https://form.typeform.com/to/${tf[1]}`;
  }
  if (!url) {
    const direct = src.match(/https?:\/\/[^\s"'<>]*typeform\.com\/to\/[A-Za-z0-9]+/i);
    if (direct) url = direct[0];
  }
  if (!url) {
    const any = src.match(/https?:\/\/[^\s"'<>]+/i);
    if (any) url = any[0];
  }
  if (!url || !/^https?:\/\//i.test(url)) return null;

  if (/(^|\.)typeform\.com\//i.test(url) && !/[?&]typeform-embed=/.test(url)) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'typeform-embed=embed-widget';
  }
  return url;
}

// Resolve a VAST tag (URL or inline XML) to a directly playable MP4 MediaFile.
// We extract the MediaFile and play it in a plain <video>, deliberately NOT
// running the VAST through a player (IMA): a serving VAST played live in a
// client-shared proof would fire Impression + quartile beacons on every open
// and pollute the campaign's delivery — the exact data this preview certifies.
// Extracting the MediaFile shows the real video without firing those beacons.
// Follows up to 4 Wrapper hops; VPAID-only ads (no MP4 MediaFile) return null
// and stay frozen. Bounded by a timeout so a slow ad server can't stall a snapshot.
function fillVastMacros(u) {
  const ts = Date.now();
  const cb = Math.floor(Math.random() * 1e12);
  return String(u)
    .replace(/\[(?:TIMESTAMP|timestamp)\]/g, String(ts))
    .replace(/\[(?:CACHEBUSTING|CACHEBUSTER|cachebuster|random|RANDOM)\]/g, String(cb))
    .replace(/%%CACHEBUSTER%%/g, String(cb));
}

function pickMp4FromVast(xml) {
  // Grab every <MediaFile ...>URL</MediaFile>, keep progressive MP4s.
  const files = [];
  const re = /<MediaFile\b([^>]*)>([\s\S]*?)<\/MediaFile>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const url = (m[2] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
    const api = (attrs.match(/\bapiFramework\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
    const width = parseInt((attrs.match(/\bwidth\s*=\s*["'](\d+)["']/i) || [, '0'])[1], 10) || 0;
    if (api === 'vpaid') continue; // not playable in a plain <video>
    const isMp4 = type.includes('mp4') || /\.mp4(\?|$)/i.test(url);
    if (isMp4) files.push({ url, width });
  }
  if (!files.length) return null;
  // Prefer the largest MP4 not wider than 1280 (good quality, light); else the
  // smallest available.
  const capped = files.filter((f) => f.width && f.width <= 1280).sort((a, b) => b.width - a.width);
  if (capped.length) return capped[0].url;
  return files.sort((a, b) => (a.width || 9999) - (b.width || 9999))[0].url;
}

async function resolveVastMediaFile(vast, hops = 0) {
  if (!vast || hops > 4) return null;
  let xml = String(vast).trim();
  try {
    if (/^https?:\/\//i.test(xml)) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      let r;
      try {
        r = await fetch(fillVastMacros(xml), {
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/xml,text/xml,*/*' },
        });
      } finally { clearTimeout(t); }
      if (!r.ok) return null;
      xml = await r.text();
    }
    if (!/<VAST|<MediaFile|<VASTAdTagURI/i.test(xml)) return null;
    // Inline ad with a MediaFile → done.
    const mp4 = pickMp4FromVast(xml);
    if (mp4) return mp4;
    // Wrapper → follow the next VASTAdTagURI.
    const wrap = xml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
    if (wrap) {
      const next = wrap[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (/^https?:\/\//i.test(next)) return resolveVastMediaFile(next, hops + 1);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Decide the live embed for a creative, server-side and deterministically.
// Returns { mode, url } or null (→ stays frozen). No client-side guessing.
//   • html5  → { mode:'iframe', url } when the hosted bundle URL is http(s)
//   • survey → { mode:'iframe', url } from resolveSurveyEmbedUrl
//   • video  → { mode:'video',  url }: the playable asset MP4 when provided,
//              else the MP4 MediaFile resolved from the VAST tag
async function resolveLive({ kind, creativeUrl, liveUrl, vastTag }) {
  if (kind === 'html5') {
    const u = String(creativeUrl || '').trim();
    return /^https?:\/\//i.test(u) ? { mode: 'iframe', url: u } : null;
  }
  if (kind === 'survey') {
    const u = resolveSurveyEmbedUrl(creativeUrl);
    return u ? { mode: 'iframe', url: u } : null;
  }
  if (kind === 'tag') {
    // HYPR AdTag only — creativeUrl carries the tag content for kind 'tag'.
    // Frame data-iframe-src BARE (no dlv/clicktag params): hypr-adtag.js only
    // counts impressions/events when the URL carries a delivery param, so the
    // bare hosted-creative URL is non-billable by design. Any other tag → null
    // (frozen) — see LIVE_KINDS comment.
    const u = resolveHyprAdtagEmbedUrl(creativeUrl);
    return u ? { mode: 'iframe', url: u } : null;
  }
  if (kind === 'video') {
    const u = String(liveUrl || '').trim();
    if (/^https?:\/\//i.test(u)) return { mode: 'video', url: u };
    const mp4 = await resolveVastMediaFile(vastTag);
    return mp4 ? { mode: 'video', url: mp4 } : null;
  }
  return null;
}

// Fetch a source only if it is an image; returns a data URI or null.
async function tryImageDataUri(src) {
  try {
    const r = await fetch(src, { redirect: 'follow' });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    // Bail before reading the body when it's clearly not an image (e.g. a
    // multi-MB mp4 passed as the video poster fallback) — avoids a wasteful
    // full download and the OOM risk that comes with it.
    if (ct && !ct.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null;
    const mime = ct.startsWith('image/') && !ct.includes('octet') ? ct.split(';')[0] : sniffImageMime(buf, '');
    if (!mime.startsWith('image/')) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Render a creative to a self-contained image data URI. Display creatives are
// fetched directly; HTML5, 3P tags and surveys are rendered in a headless page
// and screenshotted; video bakes a poster + play overlay. The bake engine stays
// image-only — no regression.
async function renderCreativeToImage(browser, { kind, src, size }) {
  if (kind === 'display' || !kind) return creativeToDataUri(src);

  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec((size || '').trim());
  const w = m ? +m[1] : 300;
  const h = m ? +m[2] : 250;

  // CM360 tag → resolve the real creative image (no headless render needed).
  if (kind === 'tag' || kind === 'survey') {
    const pm = /data-dcm-placement=['"]([^'"]+)['"]/.exec(src || '');
    if (pm) {
      const img = await resolveCm360Image(pm[1], w, h);
      if (img) return creativeToDataUri(img);
    }
  }

  const p = await browser.newPage();
  try {
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });

    if (kind === 'video') {
      // Static snapshot can't play video (and headless Chromium lacks H.264),
      // so compose the poster (thumbnail) + a play button. No poster → a neutral
      // dark VÍDEO card. Honest representation; live playback is the Live View.
      const poster = await tryImageDataUri(src);
      const u = Math.min(w, h);
      const bg = poster
        ? `background:#000 center/contain no-repeat url('${poster}');`
        : 'background:#15202b;';
      const label = poster ? '' : '<div class="lbl">VÍDEO</div>';
      const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden}.s{position:relative;width:${w}px;height:${h}px;${bg}display:flex;align-items:center;justify-content:center}.lbl{position:absolute;top:8px;left:10px;font:700 11px system-ui;letter-spacing:.08em;color:#8BA3AF}.c{width:${u * 0.26}px;height:${u * 0.26}px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}.t{width:0;height:0;border-style:solid;border-width:${u * 0.07}px 0 ${u * 0.07}px ${u * 0.11}px;border-color:transparent transparent transparent #fff;margin-left:${u * 0.03}px}</style></head><body><div class="s">${label}<div class="c"><div class="t"></div></div></div></body></html>`;
      await p.setContent(doc, { waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
      return await shotToDataUri(p, w, h);
    }

    if (kind === 'html5') {
      try { await p.goto(src, { waitUntil: 'networkidle2', timeout: 30_000 }); } catch (e) { /* render what loaded */ }
      return await shotToDataUri(p, w, h);
    }
    // tag / survey: inject the tag content and let it render
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden;background:#fff}</style></head><body>${src || ''}</body></html>`;
    try { await p.setContent(doc, { waitUntil: 'networkidle2', timeout: 30_000 }); } catch (e) { /* render what loaded */ }
    return await shotToDataUri(p, w, h);
  } finally {
    await p.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
export async function runSnapshot({ url, creativeUrl, creativeSize, creativeKind, liveUrl, vastTag, freeze, proxies }) {
  const started = Date.now();
  // Per-phase timing so we can see where the time actually goes (persisted into
  // slots_meta.phases). mark('label') records ms since the previous mark.
  const phases = {};
  let _t = started;
  const mark = (label) => { phases[label] = Date.now() - _t; _t = Date.now(); };
  const { browser, page, engine, cleanup } = await acquireBrowser({ proxies });
  mark('acquire');
  let step = 'setup';
  let consentHandled = false;
  let creativeDataUri = null;
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    try { await page.emulateTimezone('America/Sao_Paulo'); } catch (e) { /* ignore */ }

    // Asset response cache — populated DURING page load. Every body capture
    // here happens overlapped with the nav/scroll wait time; at serialize the
    // bridge serves from this map instead of refetching, turning the previously
    // serial fetch-and-transfer phase into (mostly) transfer-only. Capped per
    // asset and in total — OOM history on this function (HTTP 546) demands it.
    const assetCache = new Map();
    const downscalePending = [];
    let assetCacheBytes = 0;
    const ASSET_CACHE_LIMIT = 48 * 1024 * 1024; // transient preload duplicates this as base64 — keep headroom (OOM/546 history)
    const CACHEABLE_CT = /^(image\/|text\/css|font\/|application\/(x-)?font)/i;
    page.on('response', (resp) => {
      (async () => {
        try {
          if (resp.status() !== 200 || resp.request().method() !== 'GET') return;
          const u = resp.url();
          if (!/^https?:/i.test(u) || assetCache.has(u)) return;
          const ct = (resp.headers()['content-type'] || '').split(';')[0];
          if (!CACHEABLE_CT.test(ct)) return;
          if (assetCacheBytes >= ASSET_CACHE_LIMIT) return;
          const buf = await resp.buffer();
          if (!buf || !buf.length || buf.length > 3 * 1024 * 1024) return;
          if (assetCacheBytes + buf.length > ASSET_CACHE_LIMIT) return;
          assetCache.set(u, { buf, contentType: ct });
          assetCacheBytes += buf.length;
          // Downscale NOW, overlapped with the nav/scroll wait — doing it at
          // bridge-call time put hundreds of serial webp encodes inside the
          // serialize critical path and made it SLOWER than no cache at all.
          downscalePending.push(
            maybeDownscaleImage(buf, ct)
              .then((ds) => { if (ds.buf !== buf) assetCache.set(u, ds); })
              .catch(() => {})
          );
        } catch (e) { /* redirected/evicted body — bridge refetches on demand */ }
      })();
    });

    // Bridge SingleFile's asset fetching through Node (bypasses publisher CSP/CORS).
    try { await page.exposeFunction('__adboltFetch', (u) => nodeFetchResource(u, assetCache)); } catch (e) { /* already bound / unsupported */ }

    step = 'creative';
    const kind = creativeKind || 'display';
    // A live layer is attached for html5/survey/video, unless the caller asked
    // to freeze (static deliverable) or no concrete embed could be resolved.
    // 3P adserver tags ('tag') are only live when they are HYPR AdTags — the
    // non-billable hosted-creative URL is framed (see LIVE_KINDS). The frozen image
    // is baked either way, so a live element that errors degrades to it instead
    // of going blank. liveMeta = { mode, url } drives the client-side hydrator.
    const live = !freeze && LIVE_KINDS.has(kind)
      ? await resolveLive({ kind, creativeUrl, liveUrl, vastTag })
      : null;
    const liveMeta = live ? { mode: live.mode, url: live.url } : null;
    // Kick off the frozen render now but DON'T await — it's independent of the
    // publisher page, so it overlaps goto + scroll and its time is hidden behind
    // the page load. Awaited just before bake.
    const creativePromise = renderCreativeToImage(browser, { kind, src: creativeUrl, size: creativeSize });
    creativePromise.catch(() => {}); // avoid an unhandled-rejection warning before the await

    // Block login/consent SDKs at the network layer (cleaner than removing later).
    try {
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        try { if (BLOCK_URL_RX.test(r.url())) return r.abort(); return r.continue(); }
        catch (e) { try { r.continue(); } catch (_) { /* ignore */ } }
      });
    } catch (e) { /* interception unsupported on some remote endpoints — non-fatal */ }

    step = 'goto';
    mark('setup');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: engine === 'browserbase' ? 60_000 : NAV_TIMEOUT });
    } catch (e) { /* capture whatever rendered */ }
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 3_500 }).catch(() => {});
    mark('nav');

    step = 'consent';
    for (let i = 0; i < 3; i++) {
      let clicked = false;
      try { clicked = await page.evaluate(dismissConsentInPage); } catch { clicked = false; }
      if (clicked) { consentHandled = true; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    mark('consent');

    // Height cap reused by both scroll and trim. No point lazy-loading (and
    // waiting on) content below the line we'll delete before serialize.
    const CAP_HEIGHT = engine === 'browserbase' ? 4500 : 9000;

    step = 'scroll';
    // Cap the scroll a bit past the trim line so near-the-cut lazy images load
    // but we don't crawl a 20k px homepage we're about to throw away.
    await page.evaluate(autoScrollInPage, CAP_HEIGHT + 1200).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 2_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    mark('scroll');

    step = 'clean';
    await page.evaluate(cleanOverlaysInPage).catch(() => {});
    mark('clean');

    step = 'bake';
    creativeDataUri = await creativePromise; // overlap with page load is done here
    const bake = await page.evaluate(bakeCreativeInPage, creativeDataUri, creativeSize || '', kind, liveMeta);
    mark('bake');

    // Trim the page below a height cap before serialize. Inlining every asset of
    // a full publisher homepage is memory- and time-heavy and can OOM the
    // function (HTTP 546); the ad + surrounding context lives within the cap.
    // Runs AFTER bake so baked slots (data-adbolt) are preserved. Embedded
    // Chromium gets more headroom than the remote (Browserbase) path.
    const trimmed = await page.evaluate((cap) => {
      if (document.documentElement.scrollHeight <= cap) return false;
      for (const el of [...document.body.children]) {
        if (el.getAttribute && el.getAttribute('data-adbolt')) continue;
        if (el.querySelector && el.querySelector('[data-adbolt]')) continue;
        const top = el.getBoundingClientRect().top + window.scrollY;
        if (top > cap) { try { el.remove(); } catch (e) { /* ignore */ } }
      }
      return true;
    }, CAP_HEIGHT).catch(() => false);
    bake.trimmed = trimmed;
    bake.live = !!liveMeta;

    step = 'serialize';
    // Let in-flight downscales settle (bounded — they've had all of nav/scroll
    // to run) so the preloaded payload ships the small webp versions and no
    // sharp encode competes with the serialize for CPU.
    await Promise.race([Promise.allSettled(downscalePending), new Promise((r) => setTimeout(r, 5000))]);
    // Prefetch the gaps: hidden/lazy <img> the browser never painted (and so
    // never loaded) are absent from the load-time cache, but SingleFile will
    // request them one by one — each a serial bridge round-trip. Collect every
    // in-DOM img URL that survived the trim and bulk-fetch the missing ones in
    // parallel in Node, so they ride the preload below instead.
    try {
      const wantUrls = await page.evaluate(() => {
        const out = new Set();
        for (const img of document.querySelectorAll('img')) {
          for (const u of [img.currentSrc, img.getAttribute('src')]) {
            if (!u) continue;
            try { out.add(new URL(u, location.href).href); } catch (e) { /* skip */ }
          }
        }
        return Array.from(out).slice(0, 500);
      });
      const gaps = wantUrls.filter((u) => /^https?:/i.test(u) && !assetCache.has(u));
      await Promise.allSettled(gaps.map(async (u) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        try {
          const r = await fetch(u, { redirect: 'follow', signal: ctrl.signal });
          if (!r.ok) return;
          const ct = (r.headers.get('content-type') || '').split(';')[0];
          if (!/^image\//i.test(ct)) return;
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length || buf.length > 3 * 1024 * 1024) return;
          if (assetCacheBytes + buf.length > ASSET_CACHE_LIMIT) return;
          const ds = await maybeDownscaleImage(buf, ct);
          assetCache.set(u, ds);
          assetCacheBytes += ds.buf.length;
        } catch (e) { /* slow/broken asset — bridge handles it on demand */ }
        finally { clearTimeout(t); }
      }));
    } catch (e) { /* prefetch is best-effort */ }

    // Preload the whole asset cache into the page in ONE CDP message. The
    // per-asset exposeFunction round-trip (page→Node→page over the remote
    // websocket) was the dominant serialize cost — ~100-200 calls × RTT. A
    // single bulk transfer collapses that to one message; bridged() then
    // resolves cached assets synchronously in-page.
    const preload = {};
    for (const [u, v] of assetCache) preload[u] = { b: v.buf.toString('base64'), ct: v.contentType };
    await page.evaluate((m) => { window.__adboltAssets = m; }, preload).catch(() => {});
    await page.evaluate(SINGLEFILE_BUNDLE);
    const html = await page.evaluate(async (noCsp) => {
      // Same-origin assets pass CSP/CORS natively, so fetch them directly — fast,
      // parallel, no base64 round-trip. The Node bridge (window.__adboltFetch) is
      // reserved for cross-origin assets, which is the only case it's needed for
      // (publisher CDNs blocked by CORS / page CSP). Bridge is also the fallback
      // if a same-origin native fetch fails.
      // Time-bound in-page fetches the same way the Node bridge is bounded — a
      // hanging same-origin asset must not stall the serialize either.
      const tfetch = (url) => {
        try { return fetch(url, { signal: AbortSignal.timeout(4000) }); }
        catch (e) { return fetch(url); }
      };
      const bridge = async (url) => {
        try {
          if (typeof window.__adboltFetch === 'function') {
            const r = await window.__adboltFetch(typeof url === 'string' ? url : String(url));
            if (r && r.base64) {
              const bin = atob(r.base64);
              const arr = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
              return new Response(arr, { status: r.status || 200, headers: r.headers || {} });
            }
            if (r && r.status && !r.base64) return new Response('', { status: r.status });
          }
        } catch (e) { /* fall through */ }
        return tfetch(url);
      };
      const bridged = async (url) => {
        // Same-origin → native fetch (parallel, browser HTTP cache, zero CDP).
        // Cross-origin → straight to the bridge: a native-first attempt was
        // benchmarked and REGRESSED serialize ~35% — on CORS-less CDNs (the
        // common publisher case) every asset paid a doomed fetch round-trip
        // before bridging. The bridge is cheap now (load-time response cache).
        const abs = (() => { try { return new URL(url, location.href).href; } catch (e) { return String(url); } })();
        const pre = (window.__adboltAssets || {})[abs] || (window.__adboltAssets || {})[String(url)];
        if (pre) {
          const bin = atob(pre.b);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return new Response(arr, { status: 200, headers: { 'content-type': pre.ct || '' } });
        }
        let sameOrigin = false;
        try { sameOrigin = new URL(url, location.href).origin === location.origin; } catch (e) { /* treat as cross-origin */ }
        if (sameOrigin) {
          try { const res = await tfetch(url); if (res && res.ok) return res; } catch (e) { /* fall back to bridge */ }
        }
        return bridge(url);
      };
      window.singlefile.init({ fetch: bridged });
      const data = await window.singlefile.getPageData({
        removeUnusedStyles: true,
        removeUnusedFonts: true,
        removeHiddenElements: false,
        removeScripts: true,
        blockScripts: true,
        blockVideos: true,
        blockAudios: true,
        compressHTML: true,
        removeAlternativeFonts: true,
        removeAlternativeMedias: true,
        removeAlternativeImages: true,
        saveOriginalURLs: false,
        // Skip large embedded resources — they dominate inline time and rarely
        // matter for an ad-in-context preview.
        maxResourceSizeEnabled: true,
        maxResourceSize: 2,
        // With a live layer the injected hydrator + live <iframe> must run, so
        // we skip SingleFile's restrictive CSP meta (and strip the publisher's
        // own below).
        insertMetaCSP: !noCsp,
      });
      return data.content;
    }, !!liveMeta);
    mark('serialize');

    // Live mode: the serialized HTML carries only the slot attributes
    // (data-adbolt-live-mode/-url) + the frozen <img> backstop. The live layer
    // is mounted by the player (snapshot.html) after it frames this document,
    // NOT injected here: a captured page can contain many escaped `</body>`
    // strings inside ad <iframe srcdoc> payloads, so injecting before "</body>"
    // landed the hydrator inside an ad blob (as inert text) and it never ran.
    // We only strip the publisher CSP so the player's live <iframe>/<video>
    // (frame-src) is not blocked once mounted.
    const finalHtml = liveMeta ? stripCspMeta(html) : html;

    const title = await page.title().catch(() => '');
    bake.phases = phases;
    bake.cache = assetCache.__stats ? { hit: assetCache.__stats.hit, miss: assetCache.__stats.miss } : null;
    return {
      html: finalHtml,
      slots: bake,
      meta: { engine, consentHandled, durationMs: Date.now() - started, title, phases, live: !!liveMeta, cacheStats: assetCache.__stats || { hit: 0, miss: 0 } },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${engine}:${step} @${Date.now() - started}ms] ${msg}`);
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_token' });
  const userId = userData.user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  let normalized = String(body.url || '').trim();
  if (!normalized) return res.status(400).json({ error: 'missing_url' });
  if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
  let parsed;
  try { parsed = new URL(normalized); } catch { return res.status(400).json({ error: 'invalid_url' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).json({ error: 'url_must_be_http' });
  if (isBlockedHost(parsed.hostname)) return res.status(400).json({ error: 'blocked_host' });
  if (!body.creativeUrl) return res.status(400).json({ error: 'missing_creative' });

  let result, lastErr, firstErr = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      result = await runSnapshot({
        url: parsed.toString(),
        creativeUrl: String(body.creativeUrl),
        creativeSize: body.creativeSize,
        creativeKind: body.creativeKind || 'display',
        liveUrl: body.liveUrl ? String(body.liveUrl) : '',
        vastTag: body.vastTag ? String(body.vastTag) : '',
        freeze: !!body.freeze,
        proxies: body.proxies,
      });
      lastErr = null;
      break;
    } catch (err) { lastErr = err; if (!firstErr) firstErr = String(err && err.message || err); }
  }
  if (!result) {
    return res.status(502).json({ error: 'snapshot_failed', message: String(lastErr && lastErr.message || lastErr) });
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // Upload the self-contained HTML to storage.
  const _tUp = Date.now();
  const htmlPath = `${userId}/snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  const { error: upErr } = await userClient.storage
    .from('checkins')
    .upload(htmlPath, Buffer.from(result.html, 'utf8'), { contentType: 'text/html', upsert: false });
  if (upErr) return res.status(500).json({ error: 'upload_failed', message: String(upErr.message || upErr) });
  const snapshotUrl = userClient.storage.from('checkins').getPublicUrl(htmlPath).data.publicUrl;

  // Full timing picture into slots_meta.phases: which engine, how big the HTML
  // is, how long the upload took, and whether a silent retry happened (a failed
  // first attempt is invisible in the per-run phases but doubles wall time).
  if (result.slots && typeof result.slots === 'object') {
    result.slots.phases = result.slots.phases || {};
    result.slots.phases.engine = result.meta.engine;
    result.slots.phases.htmlKB = Math.round((result.html || '').length / 1024);
    result.slots.phases.upload = Date.now() - _tUp;
    result.slots.phases.attempts = attempts;
    if (attempts > 1 && firstErr) result.slots.phases.firstError = String(firstErr).slice(0, 220);
  }

  // Persist a shareable check-in row.
  const { data, error } = await userClient
    .from('checkins')
    .insert({
      kind: 'snapshot',
      page_url: parsed.toString(),
      page_title: result.meta.title || null,
      screenshot_url: snapshotUrl,   // kept non-null for legacy schema; same URL
      snapshot_url: snapshotUrl,
      page_width: 1440,
      page_height: 900,
      device_scale_factor: 1,
      creative_url: String(body.creativeUrl),
      creative_size: body.creativeSize || null,
      slots_meta: result.slots,
      box: null,
    })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: 'persist_failed', message: String(error.message || error) });

  return res.status(200).json({
    shareId: data.id,
    snapshotUrl,
    slots: result.slots,
    meta: result.meta,
  });
  } catch (err) {
    // Surface the actual cause: an uncaught throw here is what shows up in the
    // browser as an opaque "500 Internal Server Error". Now the response body
    // (and the frontend error message) carries the real message + step.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack || '').split('\n').slice(0, 5).join(' | ') : '';
    console.error('[snapshot] uncaught:', message, stack);
    if (!res.headersSent) return res.status(500).json({ error: 'internal', message, stack });
  }
}
