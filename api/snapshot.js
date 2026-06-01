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
      proxies: !!proxies,
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

// Fetch a page resource (image/css/font) in Node — no CORS, not subject to the
// publisher's CSP. SingleFile runs inside the page and its in-page fetch of
// cross-origin assets (publisher CDN images, fonts) is blocked, leaving the
// page's own images blank. Exposed to the page as window.__adboltFetch so
// SingleFile can inline everything through Node instead.
async function nodeFetchResource(url) {
  try {
    if (!/^https?:/i.test(url)) return { status: 0, base64: '', headers: {} };
    const r = await fetch(url, { redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return { status: 0, base64: '', headers: {} }; // skip huge assets
    return {
      status: r.status,
      base64: buf.toString('base64'),
      headers: { 'content-type': r.headers.get('content-type') || '' },
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

// Origin that serves /preview/render-tag.html and /api/ad-proxy. The live layer
// MUST load from a real https origin: 3P ad loaders (dcmads.js, Sizmek, ...)
// probe window.location.protocol and refuse to run on blob:/opaque origins,
// which is why inlining the tag into the serialized (blob-served) page goes
// blank. Pointing an <iframe> at this origin is the only reliable path.
const PUBLIC_ORIGIN = process.env.PUBLIC_PREVIEW_ORIGIN || 'https://adbolt.hypr.mobi';

// Kinds that get a live layer laid over the frozen image. display/video have no
// meaningful "live" form, so they stay frozen and never carry live metadata.
const LIVE_KINDS = new Set(['html5', 'tag', 'survey']);

// Strip the publisher's own CSP <meta> tags from the serialized HTML. They
// survive SingleFile and would block both the injected hydrator script and the
// live <iframe> (frame-src/script-src). Safe to drop in a static deliverable.
function stripCspMeta(html) {
  return html.replace(
    /<meta[^>]*http-equiv\s*=\s*['"]?content-security-policy(?:-report-only)?['"]?[^>]*>/gi,
    ''
  );
}

// The hydrator runs in the final (serialized) page. For each slot tagged with
// data-adbolt-live-kind it lays a live <iframe> over the frozen <img>:
//   • html5 → the hosted creative URL directly
//   • tag/survey → /preview/render-tag.html (CM360 ad-proxy fast-path +
//     document.write fallback, all at https so 3P loaders run)
// The iframe is transparent and z-stacked above the image; if the renderer
// posts an error, or never reports loaded within the timeout, the iframe is
// removed and the frozen image shows through. Net result: live when it can,
// frozen when it can't, never blank.
function buildHydratorScript(origin) {
  const body = `(function(){
  var ORIGIN=${JSON.stringify(origin || PUBLIC_ORIGIN)};
  function dec(b64){try{var s=atob(b64);var a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return new TextDecoder('utf-8').decode(a);}catch(e){return null;}}
  var slots=document.querySelectorAll('[data-adbolt-live-kind]');
  var reg={};
  Array.prototype.forEach.call(slots,function(slot,i){
    var kind=slot.getAttribute('data-adbolt-live-kind');
    var b64=slot.getAttribute('data-adbolt-live-src');
    if(!kind||!b64)return;
    var raw=dec(b64);if(!raw)return;
    var r=slot.getBoundingClientRect();
    var w=Math.round(r.width)||300,h=Math.round(r.height)||250;
    // If the creative is already a direct iframe embed (Typeform and most modern
    // surveys/3P), or an html5 hosted URL, frame that URL straight — no
    // render-tag wrapper, no document.write nesting. The extra layers were what
    // left the live frame blank-but-click-eating over the frozen image. Only
    // real script-loader tags (dcmads, etc.) still go through render-tag.html.
    var direct=null;
    if(kind==='html5'){var u=raw.trim();if(/^https?:/i.test(u))direct=u;}
    else{var im=raw.match(/<iframe[^>]*\\ssrc=["']([^"']+)["']/i);if(im&&/^https?:\\/\\//i.test(im[1]))direct=im[1];}
    var url,watch=false;
    if(direct){url=direct;}
    else{url=ORIGIN+'/preview/render-tag.html#tag='+encodeURIComponent(b64)+'&w='+w+'&h='+h+'&id=al'+i;watch=true;}
    var f=document.createElement('iframe');
    f.setAttribute('data-adbolt-live','1');
    f.setAttribute('scrolling','no');
    f.setAttribute('allow','fullscreen');
    f.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms');
    f.style.cssText='position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:transparent;z-index:2';
    f.src=url;
    if(getComputedStyle(slot).position==='static')slot.style.position='relative';
    slot.appendChild(f);
    if(watch){var id2='al'+i;reg[id2]={frame:f,settled:false};reg[id2].to=setTimeout(function(){var e=reg[id2];if(e&&!e.settled){e.settled=true;try{e.frame.remove();}catch(x){}}},5000);}
  });
  window.addEventListener('message',function(ev){
    var d=ev&&ev.data;if(!d||d.source!=='adbolt-render-tag')return;
    var e=d.id&&reg[d.id];if(!e||e.settled)return;
    if(d.type==='loaded'){e.settled=true;clearTimeout(e.to);}
    else if(d.type==='error'){e.settled=true;clearTimeout(e.to);try{e.frame.remove();}catch(x){}}
  });
})();`;
  return `<script>${body}</script>`;
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
async function runSnapshot({ url, creativeUrl, creativeSize, creativeKind, freeze, proxies, publicOrigin }) {
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

    // Bridge SingleFile's asset fetching through Node (bypasses publisher CSP/CORS).
    try { await page.exposeFunction('__adboltFetch', nodeFetchResource); } catch (e) { /* already bound / unsupported */ }

    step = 'creative';
    const kind = creativeKind || 'display';
    // A live layer is attached automatically for html5/tag/survey unless the
    // caller asked to freeze (static deliverable). display/video are always
    // frozen — there's no meaningful live form. The frozen image is rendered
    // either way, so a live layer that fails degrades to it instead of going
    // blank. liveMeta carries the source the client-side hydrator needs.
    const wantLive = !freeze && LIVE_KINDS.has(kind);
    const liveMeta = wantLive
      ? { kind, b64: Buffer.from(String(creativeUrl), 'utf8').toString('base64') }
      : null;
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
    await page.evaluate(SINGLEFILE_BUNDLE);
    const html = await page.evaluate(async (noCsp) => {
      // Same-origin assets pass CSP/CORS natively, so fetch them directly — fast,
      // parallel, no base64 round-trip. The Node bridge (window.__adboltFetch) is
      // reserved for cross-origin assets, which is the only case it's needed for
      // (publisher CDNs blocked by CORS / page CSP). Bridge is also the fallback
      // if a same-origin native fetch fails.
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
        return fetch(url);
      };
      const bridged = async (url) => {
        let sameOrigin = false;
        try { sameOrigin = new URL(url, location.href).origin === location.origin; } catch (e) { /* treat as cross-origin */ }
        if (sameOrigin) {
          try { const res = await fetch(url); if (res && res.ok) return res; } catch (e) { /* fall back to bridge */ }
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
        // With a live layer the injected hydrator + live <iframe> must run, so
        // we skip SingleFile's restrictive CSP meta (and strip the publisher's
        // own below).
        insertMetaCSP: !noCsp,
      });
      return data.content;
    }, !!liveMeta);
    mark('serialize');

    // Live mode: drop the publisher CSP so the hydrator + live iframes run, then
    // inject the hydrator at end of body. Frozen mode ships the static HTML as-is.
    let finalHtml = html;
    if (liveMeta) {
      finalHtml = stripCspMeta(html);
      const hydrator = buildHydratorScript(publicOrigin);
      finalHtml = /<\/body>/i.test(finalHtml)
        ? finalHtml.replace(/<\/body>/i, `${hydrator}</body>`)
        : finalHtml + hydrator;
    }

    const title = await page.title().catch(() => '');
    bake.phases = phases;
    return {
      html: finalHtml,
      slots: bake,
      meta: { engine, consentHandled, durationMs: Date.now() - started, title, phases, live: !!liveMeta },
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
  // Live iframes load render-tag.html from the same deployment that generated
  // the snapshot, so a preview deploy references its own renderer (and the
  // production custom domain stays stable for shared links).
  const fwdProto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const fwdHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const publicOrigin = fwdHost ? `${fwdProto}://${fwdHost}` : PUBLIC_ORIGIN;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      result = await runSnapshot({
        url: parsed.toString(),
        creativeUrl: String(body.creativeUrl),
        creativeSize: body.creativeSize,
        creativeKind: body.creativeKind || 'display',
        freeze: !!body.freeze,
        proxies: body.proxies,
        publicOrigin,
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
