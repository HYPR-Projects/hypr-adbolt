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

  it('skips slots not booked for the creative size', () => {
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
