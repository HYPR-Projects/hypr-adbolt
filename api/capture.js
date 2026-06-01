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

export const config = { maxDuration: 60 };

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://adfnabuwzmojxbhcpdpe.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkZm5hYnV3em1vanhiaGNwZHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MTcxODcsImV4cCI6MjA5MTA5MzE4N30.sU9EZAnQ2mClIsMwfccR5__nbTYnfzkt3IvP-llxpno';

const NAV_TIMEOUT = 45_000;

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

async function runCapture({ url, width, height, deviceScaleFactor, creativeSize, keepAds }) {
  const started = Date.now();
  const dsf = deviceScaleFactor || 2;
  const browser = await launchBrowser();
  let consentHandled = false;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: width || 1440, height: height || 900, deviceScaleFactor: dsf });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    try { await page.emulateTimezone('America/Sao_Paulo'); } catch (e) { /* ignore */ }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 8_000 }).catch(() => {});

    for (let i = 0; i < 4; i++) {
      let clicked = await page.evaluate(dismissConsentInPage).catch(() => false);
      if (!clicked) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const fc = await frame.evaluate(dismissConsentInPage).catch(() => false);
          if (fc) { clicked = true; break; }
        }
      }
      if (clicked) { consentHandled = true; break; }
      await new Promise((r) => setTimeout(r, 600));
    }

    await page.evaluate(autoScrollInPage).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 4_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    const analysis = await page.evaluate(analyzePageForAds, {
      creativeSize: creativeSize || null,
      hideAds: keepAds ? false : true,
    });

    const shot = await page.screenshot({ fullPage: true, type: 'png' });
    const title = await page.title().catch(() => '');

    return {
      buffer: Buffer.from(shot),
      slots: analysis.slots,
      pageWidth: analysis.pageWidth,
      pageHeight: analysis.pageHeight,
      deviceScaleFactor: dsf,
      meta: { consentHandled, durationMs: Date.now() - started, title },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // Self-test (no auth): confirms Chromium launches in this environment.
  if (req.method === 'GET') {
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

  let result;
  try {
    result = await runCapture({
      url: parsed.toString(),
      width: body.width,
      height: body.height,
      deviceScaleFactor: body.deviceScaleFactor,
      creativeSize: body.creativeSize,
      keepAds: body.keepAds,
    });
  } catch (err) {
    return res.status(502).json({ error: 'capture_failed', message: String(err && err.message || err) });
  }

  // Upload the screenshot to Storage (response body limit is ~4.5MB, so no base64).
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`;
  const { error: upErr } = await userClient.storage
    .from('checkins')
    .upload(path, result.buffer, { contentType: 'image/png', upsert: false });
  if (upErr) {
    return res.status(500).json({ error: 'upload_failed', message: upErr.message });
  }
  const { data: pub } = userClient.storage.from('checkins').getPublicUrl(path);

  return res.status(200).json({
    url: parsed.toString(),
    screenshotUrl: pub.publicUrl,
    storagePath: path,
    pageWidth: result.pageWidth,
    pageHeight: result.pageHeight,
    deviceScaleFactor: result.deviceScaleFactor,
    slots: result.slots,
    meta: result.meta,
  });
}
