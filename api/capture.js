// AdBolt checkin renderer (embedded Vercel Node function).
//
// Loads a publisher page like a normal browser (no header bypass), dismisses the
// consent wall, triggers lazy-loaded ads, detects ad slots, blanks the real ads,
// screenshots the full page, uploads the PNG to Supabase Storage, and returns the
// URL + slot geometry. The AdBolt frontend overlays the creative on top.
//
// Runtime: Node (NOT edge — edge cannot run Chromium). Memory/maxDuration set in
// vercel.json. Auth: Supabase user JWT (Bearer) verified via getUser.

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 180 };

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://adfnabuwzmojxbhcpdpe.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkZm5hYnV3em1vanhiaGNwZHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MTcxODcsImV4cCI6MjA5MTA5MzE4N30.sU9EZAnQ2mClIsMwfccR5__nbTYnfzkt3IvP-llxpno';

const NAV_TIMEOUT = 45_000;

// Browserbase: when the API key is set, captures run on a stealth remote browser
// (unblocks bot-protected publishers like globo). Falls back to embedded Chromium.
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY || '';
const BROWSERBASE_PROJECT_ID =
  process.env.BROWSERBASE_PROJECT_ID || '3798efe6-2de2-4c29-81cc-4bb9d4af54bc';

// ---------------------------------------------------------------------------
// SSRF guard: only public http(s) hosts.
// ---------------------------------------------------------------------------
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  // IPv4 private / link-local ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Browser-context scripts (serialized into the page; must be self-contained).
// ---------------------------------------------------------------------------
function dismissConsentInPage() {
  const SELECTORS = [
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyButtonAccept',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button[aria-label*="aceitar" i]',
    'button[aria-label*="accept" i]',
    'button[title*="aceitar" i]',
    '.fc-cta-consent',
    '.fc-button.fc-cta-consent',
    'button[mode="primary"]',
  ];
  const TEXTS = [
    'aceitar todos', 'aceitar e fechar', 'aceitar cookies', 'aceitar', 'aceito',
    'concordar', 'concordo', 'continuar', 'prosseguir', 'entendi',
    'estou de acordo', 'accept all', 'accept', 'i agree', 'agree', 'got it',
  ];
  function clickInRoot(root) {
    for (const sel of SELECTORS) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return true; }
    }
    const clickables = Array.from(
      root.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]')
    );
    for (const el of clickables) {
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!label || label.length > 40) continue;
      if (TEXTS.some((t) => label === t || label.startsWith(t))) {
        if (el.offsetParent !== null) { el.click(); return true; }
      }
    }
    return false;
  }
  if (clickInRoot(document)) return true;
  for (const host of document.querySelectorAll('*')) {
    if (host.shadowRoot && clickInRoot(host.shadowRoot)) return true;
  }
  return false;
}

function autoScrollInPage() {
  return new Promise((resolve) => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    let y = 0;
    const max = () => document.documentElement.scrollHeight;
    const timer = setInterval(() => {
      window.scrollTo(0, y);
      y += step;
      if (y >= max()) {
        clearInterval(timer);
        setTimeout(() => { window.scrollTo(0, 0); resolve(); }, 350);
      }
    }, 250);
  });
}

function analyzePageForAds(cfg) {
  const IAB_SIZES = [
    [300, 250], [336, 280], [300, 600], [160, 600], [120, 600], [120, 240],
    [728, 90], [970, 90], [970, 250], [970, 66], [320, 50], [320, 100],
    [300, 100], [468, 60], [250, 250], [200, 200], [234, 60], [180, 150],
    [125, 125], [300, 1050], [240, 400], [250, 360], [580, 400],
  ];
  const SIZE_TOL = 10;
  const slots = [];
  const seen = new Set();
  function matchSize(w, h) {
    let best = null, bestD = SIZE_TOL + 1;
    for (const [iw, ih] of IAB_SIZES) {
      const d = Math.abs(iw - w) + Math.abs(ih - h);
      if (d < bestD) { bestD = d; best = iw + 'x' + ih; }
    }
    return best;
  }
  function add(el, source, confidence) {
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 25) return;
    if (r.width > 1200 && r.height > 1200) return;
    const x = Math.round(r.left + window.scrollX);
    const y = Math.round(r.top + window.scrollY);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    const key = x + ',' + y + ',' + w + ',' + h;
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({ x, y, w, h, size: matchSize(w, h), source, confidence });
  }
  try {
    const gt = window.googletag;
    if (gt && typeof gt.pubads === 'function') {
      for (const slot of gt.pubads().getSlots()) {
        const el = document.getElementById(slot.getSlotElementId());
        if (el) add(el, 'googletag', 0.98);
      }
    }
  } catch (e) { /* ignore */ }
  document.querySelectorAll('div[id^="div-gpt-ad"], div[id*="div-gpt-ad"], div[id*="google_ads_div"]')
    .forEach((el) => add(el, 'gpt', 0.95));
  document.querySelectorAll('iframe[id*="google_ads_iframe"], iframe[src*="doubleclick"], iframe[src*="safeframe"], iframe[id*="-ad-"], ins.adsbygoogle')
    .forEach((el) => add(el, 'adframe', 0.9));
  document.querySelectorAll('[class*="advertisement"], [class*="ad-slot"], [class*="ad_slot"], [class*="adslot"], [class*="ad-unit"], [class*="ad-container"], [class*="publicidade"], [class*="anuncio"], [id*="banner-ad"], [data-ad-slot]')
    .forEach((el) => add(el, 'pattern', 0.6));
  let scanned = 0;
  for (const el of document.querySelectorAll('div, ins, aside, section, a')) {
    if (scanned > 4000) break;
    scanned++;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w < 120 || h < 50) continue;
    if (matchSize(w, h)) add(el, 'iab-size', 0.45);
  }
  let recommendedIdx = -1;
  if (cfg.creativeSize) {
    const m = /^(\d+)x(\d+)$/.exec(String(cfg.creativeSize).trim());
    if (m) {
      const tw = Number(m[1]), th = Number(m[2]);
      let bestScore = -1;
      slots.forEach((s, i) => {
        if (s.confidence < 0.6) return;
        if (s.size === cfg.creativeSize) {
          const score = 1000 + s.confidence;
          if (score > bestScore) { bestScore = score; recommendedIdx = i; }
          return;
        }
        const dw = Math.abs(s.w - tw) / tw, dh = Math.abs(s.h - th) / th;
        if (dw > 0.4 || dh > 0.4) return;
        const score = 100 - (dw + dh) * 50 + s.confidence;
        if (score > bestScore) { bestScore = score; recommendedIdx = i; }
      });
    }
  }
  let hidden = 0;
  if (cfg.hideAds) {
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483640;pointer-events:none;';
    document.body.appendChild(layer);
    slots.forEach((s) => {
      if (s.confidence < 0.85) return;
      const o = document.createElement('div');
      o.style.cssText = 'position:absolute;left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px;background:#f4f4f5;border:1px solid #e4e4e7;box-sizing:border-box;';
      layer.appendChild(o);
      hidden++;
    });
  }
  return {
    slots: slots.map((s, i) => ({ ...s, recommended: i === recommendedIdx })),
    hidden,
    pageWidth: Math.round(document.documentElement.scrollWidth),
    pageHeight: Math.round(document.documentElement.scrollHeight),
  };
}

// ---------------------------------------------------------------------------
async function launchBrowser() {
  chromium.setGraphicsMode = false;
  return puppeteer.launch({
    args: [...chromium.args, '--disable-blink-features=AutomationControlled'],
    executablePath: await chromium.executablePath(),
    headless: true,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
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

// Returns { browser, page, engine, cleanup }. Uses Browserbase (stealth) when the
// API key is configured, otherwise the embedded Chromium.
async function acquireBrowser({ proxies }) {
  if (BROWSERBASE_API_KEY) {
    const session = await createBrowserbaseSession(proxies);
    const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    return {
      browser, page, engine: 'browserbase',
      cleanup: () => browser.close().catch(() => {}),
    };
  }
  const browser = await launchBrowser();
  const page = await browser.newPage();
  return { browser, page, engine: 'embedded', cleanup: () => browser.close().catch(() => {}) };
}

async function runCapture({ url, width, height, deviceScaleFactor, creativeSize, keepAds, proxies }) {
  const started = Date.now();
  const { page, engine, cleanup } = await acquireBrowser({ proxies });
  // Remote CDP (Browserbase) chokes on huge screenshots from Vercel's region, so
  // capture the background at 1x there. The creative is composited at full res on
  // export, so the ad stays sharp regardless.
  const dsf = deviceScaleFactor || (engine === 'browserbase' ? 1 : 2);
  let consentHandled = false;
  let step = 'setup';
  const t = (s) => { step = s; };
  try {
    await page.setViewport({ width: width || 1440, height: height || 900, deviceScaleFactor: dsf });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    try { await page.emulateTimezone('America/Sao_Paulo'); } catch (e) { /* ignore */ }

    // Non-fatal navigation: heavy pages (esp. via proxy) may not settle; we still
    // capture whatever rendered.
    t('goto');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: engine === 'browserbase' ? 90_000 : NAV_TIMEOUT });
    } catch (e) { /* continue with whatever loaded */ }
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 8_000 }).catch(() => {});

    t('consent');
    for (let i = 0; i < 4; i++) {
      let clicked = false;
      try { clicked = await page.evaluate(dismissConsentInPage); } catch { clicked = false; }
      if (!clicked) {
        let frames = [];
        try { frames = page.frames(); } catch { frames = []; }
        for (const frame of frames) {
          try {
            if (frame === page.mainFrame() || frame.isDetached()) continue;
            if (await frame.evaluate(dismissConsentInPage)) { clicked = true; break; }
          } catch { /* detached or cross-origin frame — skip */ }
        }
      }
      if (clicked) { consentHandled = true; break; }
      await new Promise((r) => setTimeout(r, 600));
    }

    t('scroll');
    await page.evaluate(autoScrollInPage).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 4_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    t('analyze');
    const analysis = await page.evaluate(analyzePageForAds, {
      creativeSize: creativeSize || null,
      hideAds: keepAds ? false : true,
    });

    // Remote headless instances (Browserbase) can OOM when rendering a very tall
    // off-screen clip of an ad-heavy page, which closes the target. Keep the
    // captured region modest there; embedded Chromium can take more.
    const CAP_HEIGHT = engine === 'browserbase' ? 4000 : 8000;
    const captureHeight = Math.min(analysis.pageHeight, CAP_HEIGHT);

    t('screenshot');
    // Screenshot just the captured region by sizing the viewport to it (a normal
    // viewport capture is lighter on the renderer than a tall off-screen clip).
    await page.setViewport({ width: analysis.pageWidth, height: captureHeight, deviceScaleFactor: dsf });
    await new Promise((r) => setTimeout(r, 250));
    const shot = await page.screenshot({ type: 'jpeg', quality: 82, captureBeyondViewport: false });
    const title = await page.title().catch(() => '');

    const slots = analysis.slots.filter((s) => s.y < captureHeight);

    return {
      buffer: Buffer.from(shot),
      mime: 'image/jpeg',
      ext: 'jpg',
      slots,
      pageWidth: analysis.pageWidth,
      pageHeight: captureHeight,
      fullPageHeight: analysis.pageHeight,
      truncated: analysis.pageHeight > CAP_HEIGHT,
      deviceScaleFactor: dsf,
      meta: { consentHandled, durationMs: Date.now() - started, title, engine },
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
  // Self-test (no auth): confirms Chromium launches in this environment.
  if (req.method === 'GET') {
    // Temporary gated diagnostic: runs a full capture from Vercel's environment.
    if (req.query?.diag === 'hypr-diag-9f3') {
      const url = (typeof req.query.url === 'string' && req.query.url) || 'https://www.cnnbrasil.com.br/';
      const proxies = req.query.proxies === '1';
      try {
        const r = await runCapture({ url, proxies });
        return res.status(200).json({
          ok: true, engine: r.meta.engine, durationMs: r.meta.durationMs,
          slots: r.slots.length, pageHeight: r.pageHeight, bytes: r.buffer.length,
          consent: r.meta.consentHandled, title: r.meta.title,
        });
      } catch (err) {
        return res.status(200).json({ ok: false, error: String(err && err.message || err) });
      }
    }
    if (req.query?.selftest === '1') {
      try {
        const b = await launchBrowser();
        const v = await b.version();
        await b.close();
        return res.status(200).json({ ok: true, chromium: v });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err && err.message || err) });
      }
    }
    return res.status(200).json({ ok: true, hint: 'POST a JSON body { url } with a Bearer token.' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Auth: Supabase user JWT.
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_token' });
  const userId = userData.user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!body.url || typeof body.url !== 'string') {
    return res.status(400).json({ error: 'missing_url' });
  }
  let parsed;
  try { parsed = new URL(body.url); } catch { return res.status(400).json({ error: 'invalid_url' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'url_must_be_http' });
  }
  if (isBlockedHost(parsed.hostname)) {
    return res.status(400).json({ error: 'blocked_host' });
  }

  let result, lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await runCapture({
        url: parsed.toString(),
        width: body.width,
        height: body.height,
        deviceScaleFactor: body.deviceScaleFactor,
        creativeSize: body.creativeSize,
        keepAds: body.keepAds,
        proxies: body.proxies,
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!result) {
    return res.status(502).json({ error: 'capture_failed', message: String(lastErr && lastErr.message || lastErr) });
  }

  // Upload the screenshot to Storage (response body limit is ~4.5MB, so no base64).
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${result.ext}`;
  const { error: upErr } = await userClient.storage
    .from('checkins')
    .upload(path, result.buffer, { contentType: result.mime, upsert: false });
  if (upErr) {
    return res.status(500).json({ error: 'upload_failed', message: String(upErr.message || upErr) });
  }
  const { data: pub } = userClient.storage.from('checkins').getPublicUrl(path);

  return res.status(200).json({
    url: parsed.toString(),
    screenshotUrl: pub.publicUrl,
    storagePath: path,
    pageWidth: result.pageWidth,
    pageHeight: result.pageHeight,
    fullPageHeight: result.fullPageHeight,
    truncated: result.truncated,
    deviceScaleFactor: result.deviceScaleFactor,
    slots: result.slots,
    meta: result.meta,
  });
}
