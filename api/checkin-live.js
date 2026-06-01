// AdBolt live checkin: a persistent Browserbase session navigated to a publisher
// page, with the creative injected into matching ad slots. Returns an embeddable
// Live View URL so the user can navigate the real site live, with the ad "served"
// in the slots, and screenshot any state.
//
// Actions (POST JSON): { action: 'start'|'screenshot'|'stop', ... }
// Auth: Supabase user JWT (Bearer).

import puppeteer from 'puppeteer-core';
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://adfnabuwzmojxbhcpdpe.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkZm5hYnV3em1vanhiaGNwZHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MTcxODcsImV4cCI6MjA5MTA5MzE4N30.sU9EZAnQ2mClIsMwfccR5__nbTYnfzkt3IvP-llxpno';

const BB_API_KEY = process.env.BROWSERBASE_API_KEY || '';
const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '3798efe6-2de2-4c29-81cc-4bb9d4af54bc';
const BB_BASE = 'https://api.browserbase.com/v1';

// ---------------------------------------------------------------------------
// Injection script: runs on every document (evaluateOnNewDocument) so the
// creative survives navigation. It fills ad slots that match the creative size,
// and re-applies on DOM mutations (real ad reloads). Self-contained.
// ---------------------------------------------------------------------------
function buildInjector(creativeUrl, creativeSize) {
  const fn = (CREATIVE_URL, CREATIVE_SIZE) => {
    const m = /^(\d+)x(\d+)$/.exec((CREATIVE_SIZE || '').trim());
    const target = m ? { w: +m[1], h: +m[2] } : null;
    const MARK = 'data-adbolt-filled';

    // Allow absolute slack (padding/borders around the ad) plus a small ratio.
    function sizeMatches(w, h) {
      if (!target) return false;
      const dw = Math.abs(w - target.w);
      const dh = Math.abs(h - target.h);
      return dw <= Math.max(24, target.w * 0.12) && dh <= Math.max(40, target.h * 0.18);
    }

    function place(el, isIframe) {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w < 50 || h < 30) return;
      if (target && !sizeMatches(w, h)) return;

      if (isIframe) {
        // Can't touch a cross-origin iframe's DOM — overlay the creative on top,
        // tracked to the iframe's box, and refreshed on scroll/resize.
        if (el.getAttribute(MARK) === CREATIVE_URL) return;
        el.setAttribute(MARK, CREATIVE_URL);
        const ov = document.createElement('img');
        ov.setAttribute('data-adbolt-creative', '1');
        ov.src = CREATIVE_URL;
        ov.style.cssText =
          'position:absolute;object-fit:contain;background:#fff;z-index:2147483646;' +
          'pointer-events:none;display:block;border:0;';
        document.body.appendChild(ov);
        const track = () => {
          const b = el.getBoundingClientRect();
          ov.style.left = (b.left + window.scrollX) + 'px';
          ov.style.top = (b.top + window.scrollY) + 'px';
          ov.style.width = b.width + 'px';
          ov.style.height = b.height + 'px';
          ov.style.display = (b.width < 10 || b.height < 10) ? 'none' : 'block';
        };
        track();
        window.addEventListener('scroll', track, { passive: true });
        window.addEventListener('resize', track);
        setInterval(track, 500);
        return;
      }

      if (el.getAttribute(MARK) === CREATIVE_URL) return;
      el.setAttribute(MARK, CREATIVE_URL);
      const cs = getComputedStyle(el);
      if (cs.position === 'static') el.style.position = 'relative';
      el.style.overflow = 'hidden';
      let img = el.querySelector(':scope > img[data-adbolt-creative]');
      if (!img) {
        img = document.createElement('img');
        img.setAttribute('data-adbolt-creative', '1');
        img.style.cssText =
          'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;' +
          'background:#fff;z-index:2147483646;display:block;';
        el.appendChild(img);
      }
      img.src = CREATIVE_URL;
    }

    function depthOf(el) {
      let d = 0;
      let n = el;
      while (n && n.parentElement) { d++; n = n.parentElement; }
      return d;
    }

    function scan() {
      if (!target) return;
      // Size-first: ad slots vary wildly by publisher and rarely use predictable
      // selectors, but the rendered box always matches the creative size (plus a
      // few px of padding). Find innermost elements whose box matches.
      const matches = [];
      const all = document.querySelectorAll('div, ins, aside, a, span');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.querySelector('img[data-adbolt-creative]')) continue;
        const r = el.getBoundingClientRect();
        const w = Math.round(r.width), h = Math.round(r.height);
        if (!sizeMatches(w, h)) continue;
        if (r.top + window.scrollY > 12000) continue;
        matches.push({ el, depth: depthOf(el) });
      }
      matches.sort((a, b) => b.depth - a.depth);
      const used = [];
      for (const mtc of matches) {
        if (used.some((u) => u.contains(mtc.el) || mtc.el.contains(u))) continue;
        place(mtc.el, false);
        used.push(mtc.el);
      }
    }

    function start() {
      scan();
      let raf = 0;
      const mo = new MutationObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; scan(); });
      });
      try { mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); } catch (e) { /* ignore */ }
      // Periodic re-scan catches slots that render outside mutation timing.
      setInterval(scan, 1500);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  };
  return `(${fn.toString()})(${JSON.stringify(creativeUrl)}, ${JSON.stringify(creativeSize || '')});`;
}

function dismissConsentInPage() {
  const SEL = ['#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyButtonAccept', '.fc-cta-consent', 'button[mode="primary"]'];
  const TXT = ['aceitar todos', 'aceitar', 'aceito', 'concordo', 'continuar', 'entendi', 'accept all', 'accept', 'i agree', 'got it'];
  function c(root) {
    for (const s of SEL) { const e = root.querySelector(s); if (e && e.offsetParent !== null) { e.click(); return true; } }
    for (const e of root.querySelectorAll('button, a[role="button"], [role="button"]')) {
      const l = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!l || l.length > 40) continue;
      if (TXT.some((t) => l === t || l.startsWith(t))) { if (e.offsetParent !== null) { e.click(); return true; } }
    }
    return false;
  }
  if (c(document)) return true;
  for (const h of document.querySelectorAll('*')) { if (h.shadowRoot && c(h.shadowRoot)) return true; }
  return false;
}

async function bbCreateSession(proxies) {
  const res = await fetch(`${BB_BASE}/sessions`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': BB_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: BB_PROJECT_ID,
      keepAlive: true,
      proxies: !!proxies,
      browserSettings: { viewport: { width: 1440, height: 900 } },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`bb create ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function bbDebug(sessionId) {
  const res = await fetch(`${BB_BASE}/sessions/${sessionId}/debug`, { headers: { 'X-BB-API-Key': BB_API_KEY } });
  if (!res.ok) throw new Error(`bb debug ${res.status}`);
  return res.json();
}

async function bbConnectUrl(sessionId) {
  // Reconnect to an existing session for screenshots.
  const res = await fetch(`${BB_BASE}/sessions/${sessionId}`, { headers: { 'X-BB-API-Key': BB_API_KEY } });
  if (!res.ok) throw new Error(`bb get ${res.status}`);
  const s = await res.json();
  return s.connectUrl;
}

async function bbRelease(sessionId) {
  await fetch(`${BB_BASE}/sessions/${sessionId}`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': BB_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: BB_PROJECT_ID, status: 'REQUEST_RELEASE' }),
  }).catch(() => {});
}

async function authUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { error: 'unauthorized' };
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return { error: 'invalid_token' };
  return { token, userId: data.user.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!BB_API_KEY) return res.status(503).json({ error: 'browserbase_not_configured' });

  const a = await authUser(req);
  if (a.error) return res.status(401).json({ error: a.error });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = body.action || 'start';

  try {
    if (action === 'start') {
      let normalized = String(body.url || '').trim();
      if (!normalized) return res.status(400).json({ error: 'missing_url' });
      if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
      let parsed;
      try { parsed = new URL(normalized); } catch { return res.status(400).json({ error: 'invalid_url' }); }
      if (!body.creativeUrl) return res.status(400).json({ error: 'missing_creative' });

      const session = await bbCreateSession(body.proxies);
      const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
      try {
        const page = (await browser.pages())[0] || (await browser.newPage());
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        // Inject the creative on every navigation (survives clicking around).
        await page.evaluateOnNewDocument(buildInjector(body.creativeUrl, body.creativeSize));
        try {
          await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 55_000 });
        } catch (e) { /* keep going */ }
        // Best-effort consent so the page is usable in the live view.
        for (let i = 0; i < 2; i++) {
          let clicked = false;
          try { clicked = await page.evaluate(dismissConsentInPage); } catch { clicked = false; }
          if (clicked) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        // Disconnect (NOT close) — keepAlive holds the session for the iframe.
        await browser.disconnect();
      }

      const dbg = await bbDebug(session.id);
      return res.status(200).json({
        sessionId: session.id,
        liveViewUrl: dbg.debuggerFullscreenUrl,
        expiresAt: session.expiresAt,
      });
    }

    if (action === 'screenshot') {
      if (!body.sessionId) return res.status(400).json({ error: 'missing_session' });
      const connectUrl = await bbConnectUrl(body.sessionId);
      const browser = await puppeteer.connect({ browserWSEndpoint: connectUrl });
      let buffer;
      let pageUrl = '';
      let title = '';
      try {
        const page = (await browser.pages())[0];
        if (!page) throw new Error('no active page');
        pageUrl = page.url();
        title = await page.title().catch(() => '');
        buffer = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 90 }));
      } finally {
        await browser.disconnect();
      }
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${a.token}` } },
      });
      const path = `${a.userId}/live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error: upErr } = await userClient.storage.from('checkins').upload(path, buffer, { contentType: 'image/jpeg' });
      if (upErr) return res.status(500).json({ error: 'upload_failed', message: upErr.message });
      const url = userClient.storage.from('checkins').getPublicUrl(path).data.publicUrl;
      return res.status(200).json({ screenshotUrl: url, pageUrl, title });
    }

    if (action === 'stop') {
      if (body.sessionId) await bbRelease(body.sessionId);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    return res.status(502).json({ error: 'live_failed', message: String(err && err.message || err) });
  }
}
