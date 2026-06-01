import { describe, it, expect, beforeEach } from 'vitest';
import { bakeCreativeInPage, cleanOverlaysInPage } from '../../api/_checkin/engine.js';

const CREATIVE = 'https://cdn.example/ad-300x250.png';

beforeEach(() => {
  document.body.innerHTML = '';
  (window as Window & { googletag?: unknown }).googletag = undefined;
  (window as Window & { pbjs?: unknown }).pbjs = undefined;
});

function makeSlot(id: string, w: number, h: number) {
  const el = document.createElement('div');
  el.id = id;
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ width: w, height: h, top: 100, left: 100, right: 100 + w, bottom: 100 + h }),
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

describe('bakeCreativeInPage — googletag (primary path)', () => {
  it('bakes into the slot booked for the matching size and reports source', () => {
    makeSlot('square_ad_1', 0, 0); // collapsed in headless — the real-world case
    // @ts-expect-error test stub
    window.googletag = {
      pubads: () => ({
        getSlots: () => [{
          getSlotElementId: () => 'square_ad_1',
          getSizes: () => [{ getWidth: () => 300, getHeight: () => 250 }],
        }],
      }),
    };
    const r = bakeCreativeInPage(CREATIVE, '300x250');
    expect(r.filled).toBe(1);
    expect(r.source).toBe('googletag');
    const slot = document.getElementById('square_ad_1')!;
    // Forced to declared size despite 0x0 collapse.
    expect(slot.style.width).toBe('300px');
    expect(slot.style.height).toBe('250px');
    expect(slot.querySelector('img[data-adbolt-creative]')).toBeTruthy();
  });

  it('skips a slot not booked for the creative size (incompatible)', () => {
    makeSlot('leader_1', 728, 90);
    // @ts-expect-error test stub
    window.googletag = {
      pubads: () => ({
        getSlots: () => [{
          getSlotElementId: () => 'leader_1',
          getSizes: () => [{ getWidth: () => 728, getHeight: () => 90 }],
        }],
      }),
    };
    const r = bakeCreativeInPage(CREATIVE, '300x250');
    expect(r.filled).toBe(0);
    expect(document.getElementById('leader_1')!.getAttribute('data-adbolt')).toBeNull();
  });

  it('skips out-of-page / interstitial slots that have no booked sizes', () => {
    makeSlot('dfp-interstitial', 0, 0);
    // @ts-expect-error test stub
    window.googletag = {
      pubads: () => ({
        getSlots: () => [{
          getSlotElementId: () => 'dfp-interstitial',
          getSizes: () => [],
        }],
      }),
    };
    const r = bakeCreativeInPage(CREATIVE, '970x250');
    expect(r.filled).toBe(0);
    expect(document.getElementById('dfp-interstitial')!.getAttribute('data-adbolt')).toBeNull();
  });

  it('fills a multi-size slot when its booked sizes include the creative', () => {
    makeSlot('billboard_1', 0, 0);
    // @ts-expect-error test stub
    window.googletag = {
      pubads: () => ({
        getSlots: () => [{
          getSlotElementId: () => 'billboard_1',
          getSizes: () => [
            { getWidth: () => 970, getHeight: () => 250 },
            { getWidth: () => 300, getHeight: () => 250 },
          ],
        }],
      }),
    };
    const r = bakeCreativeInPage(CREATIVE, '300x250');
    expect(r.exact).toBe(1);
    const slot = document.getElementById('billboard_1')!;
    expect(slot.getAttribute('data-adbolt-mode')).toBe('exact');
    expect(slot.style.width).toBe('300px');
    expect(slot.style.height).toBe('250px');
  });

  it('fills only the compatible billboard, skipping incompatible inserts', () => {
    makeSlot('banner_insert__001', 90, 32);
    makeSlot('banner_home1', 0, 0);
    // @ts-expect-error test stub
    window.googletag = {
      pubads: () => ({
        getSlots: () => [
          { getSlotElementId: () => 'banner_insert__001', getSizes: () => [{ getWidth: () => 90, getHeight: () => 32 }] },
          { getSlotElementId: () => 'banner_home1', getSizes: () => [{ getWidth: () => 970, getHeight: () => 250 }] },
        ],
      }),
    };
    const r = bakeCreativeInPage(CREATIVE, '970x250');
    expect(r.filled).toBe(1);
    expect(document.getElementById('banner_home1')!.getAttribute('data-adbolt')).toBe('1');
    expect(document.getElementById('banner_insert__001')!.getAttribute('data-adbolt')).toBeNull();
  });
});

describe('bakeCreativeInPage — video', () => {
  it('places the poster into a real <video> player container', () => {
    const wrap = document.createElement('div');
    const v = document.createElement('video');
    Object.defineProperty(v, 'getBoundingClientRect', {
      value: () => ({ width: 640, height: 360, top: 50, left: 0, right: 640, bottom: 410 }),
      configurable: true,
    });
    Object.defineProperty(wrap, 'getBoundingClientRect', {
      value: () => ({ width: 640, height: 360, top: 50, left: 0, right: 640, bottom: 410 }),
      configurable: true,
    });
    wrap.appendChild(v);
    document.body.appendChild(wrap);
    const r = bakeCreativeInPage(CREATIVE, '1280x720', 'video');
    expect(r.filled).toBeGreaterThanOrEqual(1);
    expect(r.source).toBe('video');
    expect(wrap.getAttribute('data-adbolt')).toBe('1');
  });

  it('falls back to the largest GAM display slot (outstream) when no player exists', () => {
    makeSlot('billboard_x', 0, 0);
    // @ts-expect-error test stub
    window.googletag = {
      pubads: () => ({
        getSlots: () => [{
          getSlotElementId: () => 'billboard_x',
          getSizes: () => [{ getWidth: () => 970, getHeight: () => 250 }, { getWidth: () => 300, getHeight: () => 250 }],
        }],
      }),
    };
    const r = bakeCreativeInPage(CREATIVE, '1280x720', 'video');
    expect(r.filled).toBe(1);
    expect(r.source).toBe('video-outstream');
    const slot = document.getElementById('billboard_x')!;
    expect(slot.getAttribute('data-adbolt')).toBe('1');
    expect(slot.style.width).toBe('970px'); // largest booked size
  });
});

describe('bakeCreativeInPage — prebid fallback', () => {
  it('uses pbjs ad units when googletag is absent', () => {
    makeSlot('div-rail', 0, 0);
    // @ts-expect-error test stub
    window.pbjs = {
      getAdUnits: () => [{ code: 'div-rail', mediaTypes: { banner: { sizes: [[300, 250]] } } }],
    };
    const r = bakeCreativeInPage(CREATIVE, '300x250');
    expect(r.filled).toBe(1);
    expect(r.source).toBe('prebid');
  });
});

describe('bakeCreativeInPage — DOM pattern fallback', () => {
  it('matches div-gpt-ad containers', () => {
    const el = makeSlot('div-gpt-ad-12345', 300, 250);
    el.id = 'div-gpt-ad-12345';
    const r = bakeCreativeInPage(CREATIVE, '300x250');
    expect(r.filled).toBeGreaterThanOrEqual(1);
    expect(r.source).toBe('pattern');
  });
});

describe('bakeCreativeInPage — size heuristic (last resort)', () => {
  it('fills the innermost box matching the creative size', () => {
    makeSlot('mystery', 300, 250);
    const r = bakeCreativeInPage(CREATIVE, '300x250');
    expect(r.filled).toBe(1);
    expect(r.source).toBe('size');
  });

  it('does nothing when no size is given and no ad signals exist', () => {
    makeSlot('plain', 300, 250);
    const r = bakeCreativeInPage(CREATIVE, '');
    expect(r.filled).toBe(0);
  });
});

describe('cleanOverlaysInPage', () => {
  it('removes a known Google sign-in iframe but preserves baked slots', () => {
    const gsi = document.createElement('iframe');
    gsi.src = 'https://accounts.google.com/gsi/iframe';
    document.body.appendChild(gsi);
    const slot = makeSlot('ad', 300, 250);
    slot.setAttribute('data-adbolt', '1');
    const removed = cleanOverlaysInPage();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('iframe[src*="accounts.google"]')).toBeNull();
    expect(document.getElementById('ad')).toBeTruthy();
  });
});
