// Shared check-in engine — pure functions that run *inside the page* (serialized
// into the browser context via page.evaluate, or pasted into a bookmarklet).
//
// They must be fully self-contained (no closures over module scope, no imports)
// because they are stringified and re-parsed in the target page. Each is exported
// so both the headless endpoint (api/snapshot.js) and the future bookmarklet can
// share exactly one implementation.

// ---------------------------------------------------------------------------
// Detect + bake the creative into real ad slots.
//
// Strategy, in order of confidence:
//   1. googletag (GAM) — the publisher's own slot registry. Deterministic: gives
//      us the exact slot container element AND the sizes it was booked for. ~all
//      BR publishers (CNN, Globo, UOL, ...) serve via GAM, so this hits first.
//   2. Prebid (pbjs) ad units — same idea when GAM isn't queryable.
//   3. DOM id/class patterns (div-gpt-ad, adslot, publicidade, ...).
//   4. Size heuristic — innermost element whose rendered box matches the creative
//      size. Last resort for publishers with none of the above.
//
// The creative is baked into the slot *container* (same-origin), whose contents
// are replaced — this destroys the cross-origin safeframe iframe instead of
// fighting it with an overlay. We force the slot to the creative's declared size
// because empty GAM slots collapse to 0x0 in headless (no ad demand).
// ---------------------------------------------------------------------------
export function bakeCreativeInPage(creativeUrl, sizeStr, kind) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec((sizeStr || '').trim());
  const target = m ? { w: +m[1], h: +m[2] } : null;
  const MARK = 'data-adbolt';
  const detail = [];
  let source = null;

  function sizeMatches(w, h) {
    if (!target) return false;
    const dw = Math.abs(w - target.w);
    const dh = Math.abs(h - target.h);
    return dw <= Math.max(20, target.w * 0.1) && dh <= Math.max(20, target.h * 0.1);
  }

  // Booked sizes worth reserving a box for. Drops 1x1 trackers and out-of-page,
  // and full-page takeovers / skins that would wreck the layout if reserved.
  function usableSizes(arr) {
    return (arr || []).filter((s) => s && s.w >= 50 && s.w <= 1800 && s.h >= 20 && s.h <= 1200);
  }

  // Publishers collapse empty ad wrappers (display:none / height:0 / hidden)
  // until their ad script fills them — which we block. A slot can match and be
  // filled yet render 0x0 because an ancestor is hidden (globo's header
  // billboard banner_home1 was exactly this). Walk up and clear the hiding
  // styles — but ONLY on tight ad wrappers, so we never force-reveal an entire
  // hidden page section (e.g. a mobile-only nav) that happens to contain a slot.
  function isAdWrapper(node) {
    if (node.childElementCount <= 3) return true; // tight container around the slot
    const idc = ((node.id || '') + ' ' + (node.className || '')).toLowerCase();
    return /\b(ad|ads|adv|dfp|gpt|banner|slot|publicidade|anuncio|advert|google)\b/.test(idc) ||
      /(ad|dfp|gpt|banner|slot|publicidade|anuncio)/.test(idc);
  }
  function reveal(el) {
    let node = el;
    let hops = 0;
    while (node && node !== document.body && node !== document.documentElement && hops < 10) {
      if (node !== el && !isAdWrapper(node)) break; // stop at the first real layout section
      let cs;
      try { cs = getComputedStyle(node); } catch (e) { break; }
      if (cs.display === 'none') node.style.setProperty('display', 'block', 'important');
      if (cs.visibility === 'hidden') node.style.setProperty('visibility', 'visible', 'important');
      if (parseFloat(cs.opacity) === 0) node.style.setProperty('opacity', '1', 'important');
      const clipped = cs.overflow === 'hidden' || cs.overflowY === 'hidden';
      const h = parseFloat(cs.height) || 0;
      if (clipped && (h === 0 || cs.maxHeight === '0px')) {
        node.style.setProperty('height', 'auto', 'important');
        node.style.setProperty('max-height', 'none', 'important');
      }
      node = node.parentElement;
      hops++;
    }
  }

  // box: the reserved slot size {w,h}. mode: 'exact' (creative size matched a
  // booked size) or 'approx' (slot reserved at its own booked size, creative
  // letterboxed inside — exactly how a real GAM slot shows an undersized ad).
  function fill(el, box, mode) {
    if (!el || el.getAttribute(MARK)) return false;
    el.setAttribute(MARK, '1');
    el.setAttribute('data-adbolt-mode', mode || 'exact');
    el.innerHTML = '';
    el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.style.margin = '0 auto';
    el.style.display = 'block';
    el.style.background = '#fff';
    const b = box || target;
    if (b) {
      el.style.width = b.w + 'px';
      el.style.minWidth = b.w + 'px';
      el.style.maxWidth = '100%';
      el.style.height = b.h + 'px';
      el.style.minHeight = b.h + 'px';
    }
    const img = document.createElement('img');
    img.src = creativeUrl;
    img.setAttribute('data-adbolt-creative', '1');
    img.style.cssText =
      'display:block;width:100%;height:100%;object-fit:contain;background:#fff;border:0;';
    el.appendChild(img);
    reveal(el);
    const r = el.getBoundingClientRect();
    detail.push(Math.round(r.width) + 'x' + Math.round(r.height) + (mode === 'approx' ? '~' : ''));
    return true;
  }

  let n = 0;
  const slots = [];
  let hadRegistry = false;

  // 0. VIDEO — a video creative's pixel size (1280x720) is never a display slot
  // size, and publishers serve video in players, not display slots. So instead
  // of size matching, find video surfaces and bake the poster there:
  //   a. real <video> players, b. known player containers, c. fallback: the
  //   largest GAM display slot (simulating an outstream unit).
  if (kind === 'video') {
    const used = [];
    function placeVideo(el) {
      if (!el || el.getAttribute(MARK)) return false;
      if (used.some((u) => u.contains(el) || el.contains(u))) return false;
      reveal(el);
      const r = el.getBoundingClientRect();
      let bw = Math.round(r.width);
      let bh = Math.round(r.height);
      if (bw < 240 || bh < 120) {
        const pw = (el.parentElement && el.parentElement.getBoundingClientRect().width) || 640;
        bw = Math.min(Math.max(Math.round(pw), 320), 1280);
        bh = Math.round((bw * 9) / 16);
      }
      if (fill(el, { w: bw, h: bh }, 'video')) {
        used.push(el);
        slots.push({ id: el.id || '(video)', booked: bw + 'x' + bh, mode: 'video', filled: true });
        return true;
      }
      return false;
    }

    document.querySelectorAll('video').forEach((v) => {
      if (n >= 2) return;
      const host = v.closest('div,section,figure,aside') || v.parentElement || v;
      if (placeVideo(host)) { n++; source = source || 'video'; }
    });
    if (!n) {
      document.querySelectorAll('[class*="player"],[class*="video-js"],[class*="jwplayer"],[class*="vjs"],[id*="player"],[class*="video-player"]')
        .forEach((el) => {
          if (n >= 2) return;
          const r = el.getBoundingClientRect();
          if (r.width >= 280 && r.height >= 140 && r.width / r.height < 4) {
            if (placeVideo(el)) { n++; source = source || 'video'; }
          }
        });
    }
    if (!n) {
      try {
        const gt = window.googletag;
        if (gt && typeof gt.pubads === 'function') {
          let best = null;
          let bestArea = 0;
          for (const slot of gt.pubads().getSlots()) {
            const id = slot.getSlotElementId && slot.getSlotElementId();
            const el = id ? document.getElementById(id) : null;
            if (!el) continue;
            const booked = usableSizes((slot.getSizes && slot.getSizes() || [])
              .map((s) => (s && s.getWidth ? { w: s.getWidth(), h: s.getHeight() } : null)).filter(Boolean));
            if (!booked.length) continue;
            const big = booked.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
            if (big.w * big.h > bestArea) { bestArea = big.w * big.h; best = { el, big }; }
          }
          if (best) {
            reveal(best.el);
            if (fill(best.el, best.big, 'video')) {
              n++; source = 'video-outstream';
              slots.push({ id: best.el.id || '(outstream)', booked: best.big.w + 'x' + best.big.h, mode: 'video-outstream', filled: true });
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
    return { filled: n, detail, source, slots, exact: 0, approx: 0 };
  }

  // 1. googletag — fill only slots whose booked sizes INCLUDE the creative size
  // (i.e. this creative would actually serve there). Slots with no booked sizes
  // are out-of-page / interstitial / anchor formats (dfp-interstitial,
  // dfp-pulse) — never in-flow placements, so we skip them rather than inject a
  // phantom banner.
  try {
    const gt = window.googletag;
    if (gt && typeof gt.pubads === 'function') {
      hadRegistry = true;
      for (const slot of gt.pubads().getSlots()) {
        const id = slot.getSlotElementId && slot.getSlotElementId();
        const el = id ? document.getElementById(id) : null;
        const booked = usableSizes(
          (slot.getSizes && slot.getSizes() || [])
            .map((s) => (s && s.getWidth ? { w: s.getWidth(), h: s.getHeight() } : null))
            .filter(Boolean)
        );
        const bookedStr = booked.map((s) => s.w + 'x' + s.h).join(',');
        if (!el) { slots.push({ id, booked: bookedStr, mode: 'no-element', filled: false }); continue; }
        if (!booked.length) { slots.push({ id, booked: '', mode: 'out-of-page', filled: false }); continue; }
        if (!target || !booked.some((s) => s.w === target.w && s.h === target.h)) {
          slots.push({ id, booked: bookedStr, mode: 'incompatible', filled: false }); continue;
        }
        const ok = fill(el, target, 'exact');
        slots.push({ id, booked: bookedStr, mode: 'exact', filled: ok });
        if (ok) { n++; source = source || 'googletag'; }
      }
    }
  } catch (e) { /* ignore */ }

  // 2. Prebid ad units — same compatible-only rule
  if (!n) {
    try {
      const pb = window.pbjs;
      if (pb && typeof pb.getAdUnits === 'function') {
        hadRegistry = true;
        for (const unit of pb.getAdUnits()) {
          const el = document.getElementById(unit.code);
          if (!el) continue;
          const sizes = (unit.mediaTypes && unit.mediaTypes.banner && unit.mediaTypes.banner.sizes) || unit.sizes || [];
          const flat = usableSizes(sizes.map((s) => (Array.isArray(s) ? { w: s[0], h: s[1] } : null)).filter(Boolean));
          if (!flat.length || !target || !flat.some((s) => s.w === target.w && s.h === target.h)) {
            slots.push({ id: unit.code, booked: flat.map((s) => s.w + 'x' + s.h).join(','), mode: 'incompatible', filled: false });
            continue;
          }
          const ok = fill(el, target, 'exact');
          slots.push({ id: unit.code, booked: flat.map((s) => s.w + 'x' + s.h).join(','), mode: 'exact', filled: ok });
          if (ok) { n++; source = source || 'prebid'; }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 3. DOM id/class patterns — ONLY when no ad registry exists (no GAM/Prebid).
  // On a GAM page that simply has no slot for this size, falling through here
  // would blindly fill div-gpt-ad containers and recreate phantom ads.
  if (!n && !hadRegistry) {
    const sel = [
      'div[id^="div-gpt-ad"]', 'div[id*="div-gpt-ad"]', 'div[id*="google_ads_div"]',
      '[class*="ad-slot"]', '[class*="ad_slot"]', '[class*="adslot"]', '[class*="ad-unit"]',
      '[class*="ad-container"]', '[class*="publicidade"]', '[class*="anuncio"]', '[data-ad-slot]',
    ].join(',');
    document.querySelectorAll(sel).forEach((el) => {
      if (n && !target) return;
      const r = el.getBoundingClientRect();
      if (target && !sizeMatches(Math.round(r.width), Math.round(r.height))) return;
      if (fill(el)) { n++; source = source || 'pattern'; }
    });
  }

  // 4. Size heuristic — innermost matching box (only when no ad registry)
  if (!n && !hadRegistry && target) {
    const matches = [];
    const all = document.querySelectorAll('div, ins, aside, section, a, span');
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      if (el.getAttribute(MARK)) continue;
      const r = el.getBoundingClientRect();
      if (!sizeMatches(Math.round(r.width), Math.round(r.height))) continue;
      let depth = 0, node = el;
      while (node && node.parentElement) { depth++; node = node.parentElement; }
      matches.push({ el, depth });
    }
    matches.sort((a, b) => b.depth - a.depth);
    const used = [];
    for (const mtc of matches) {
      if (used.some((u) => u.contains(mtc.el) || mtc.el.contains(u))) continue;
      if (fill(mtc.el)) { n++; used.push(mtc.el); source = source || 'size'; }
    }
  }

  const exact = slots.filter((s) => s.mode === 'exact' && s.filled).length;
  const approx = slots.filter((s) => s.mode === 'approx' && s.filled).length;
  return { filled: n, detail, source, slots, exact, approx };
}

// ---------------------------------------------------------------------------
// Remove overlays that would ruin the deliverable: cookie/consent walls, login
// prompts (incl. Google One Tap), paywalls, newsletter pop-ups, scroll-locks.
// Anything marked data-adbolt is preserved.
// ---------------------------------------------------------------------------
export function cleanOverlaysInPage() {
  let removed = 0;
  const vw = window.innerWidth || 1440;
  const vh = window.innerHeight || 900;
  const RX = /aceit|cookie|consent|privacidad|entrar com|fazer login|sign ?in|log ?in|continuar com|assine|cadastr|inscrev|newsletter|notifica|permitir/i;

  // Known consent/login containers (incl. Google Sign-In iframes).
  const KNOWN = [
    '#onetrust-consent-sdk', '#CybotCookiebotDialog', '.fc-consent-root',
    '[class*="cookie-banner"]', '[class*="cookieBanner"]', '[class*="paywall"]',
    '[id*="cmp-"]', '[id^="gsi_"]', 'div[aria-modal="true"]',
    'iframe[src*="accounts.google"]', 'iframe[src*="gsi/"]',
    'iframe[title*="Entrar" i]', 'iframe[title*="Sign in" i]',
  ];
  for (const s of KNOWN) {
    document.querySelectorAll(s).forEach((e) => {
      if (e.getAttribute('data-adbolt') || e.querySelector('[data-adbolt]')) return;
      e.remove();
      removed++;
    });
  }

  // Generic: fixed/sticky elements with high z-index covering a large area, or
  // any fixed element whose text reads like consent/login.
  for (const el of [...document.querySelectorAll('div, section, aside, dialog, iframe, ins')]) {
    if (el.getAttribute('data-adbolt') || (el.querySelector && el.querySelector('[data-adbolt]'))) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const big = area > vw * vh * 0.1;
    const z = parseInt(cs.zIndex, 10) || 0;
    const txt = (el.innerText || '').toLowerCase();
    if ((big && z >= 100) || (RX.test(txt) && (cs.position === 'fixed' || big))) {
      el.remove();
      removed++;
    }
  }

  // Release scroll locks left behind by removed modals.
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  if (getComputedStyle(document.body).position === 'fixed') {
    document.body.style.position = '';
    document.body.style.top = '';
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Auto-scroll to trigger lazy-loaded ads/images, then return to top.
// ---------------------------------------------------------------------------
export function autoScrollInPage(maxHeight) {
  return new Promise((resolve) => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.85));
    const cap = typeof maxHeight === 'number' && maxHeight > 0 ? maxHeight : Infinity;
    let y = 0;
    const max = () => Math.min(document.documentElement.scrollHeight, cap);
    const timer = setInterval(() => {
      window.scrollTo(0, y);
      y += step;
      if (y >= max()) {
        clearInterval(timer);
        setTimeout(() => { window.scrollTo(0, 0); resolve(); }, 300);
      }
    }, 120);
  });
}

// ---------------------------------------------------------------------------
// Best-effort consent click (run before cleanup, so a clicked banner is gone
// rather than removed — keeps the page state more natural).
// ---------------------------------------------------------------------------
export function dismissConsentInPage() {
  const SEL = [
    '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyButtonAccept',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button[aria-label*="aceitar" i]', 'button[aria-label*="accept" i]',
    '.fc-cta-consent', '.fc-button.fc-cta-consent', 'button[mode="primary"]',
  ];
  const TXT = [
    'aceitar todos', 'aceitar e fechar', 'aceitar cookies', 'aceitar', 'aceito',
    'concordar', 'concordo', 'continuar', 'prosseguir', 'entendi',
    'estou de acordo', 'accept all', 'accept', 'i agree', 'agree', 'got it',
  ];
  function clickInRoot(root) {
    for (const sel of SEL) {
      const el = root.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return true; }
    }
    const clickables = Array.from(
      root.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]')
    );
    for (const el of clickables) {
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!label || label.length > 40) continue;
      if (TXT.some((t) => label === t || label.startsWith(t))) {
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
