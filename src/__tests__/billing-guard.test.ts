import { describe, it, expect } from 'vitest';
import { auditTrackerBilling, formatBillingBlock } from '@/services/activation/billing-guard';
import type { Tracker } from '@/types';

const t = (url: string): Tracker => ({ url, format: 'url-image', dsps: 'all' });

describe('auditTrackerBilling', () => {
  it('passes a clean impression/verification set', () => {
    const items = [
      { label: 'cr1', trackers: [t('https://tps.doubleverify.com/visit.gif?ctx=1'), t('https://ad.example.com/trackimp/p.gif')] },
    ];
    expect(auditTrackerBilling(items)).toHaveLength(0);
  });

  it('blocks a click tracker sitting in the impression array', () => {
    const items = [
      { label: 'cr_click', trackers: [t('https://ad.doubleclick.net/ddm/trackclk/N1/B123.456;dc_trk_aid=1')] },
    ];
    const issues = auditTrackerBilling(items);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('click-as-impression');
    expect(issues[0].severity).toBe('block');
  });

  it('blocks a tracker whose purpose cannot be determined', () => {
    const items = [{ label: 'cr_unknown', trackers: [t('https://random.example.com/path/thing')] }];
    const issues = auditTrackerBilling(items);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('unknown-purpose');
  });

  it('re-derives from URL and ignores a misleading stored role', () => {
    // Stored role says verification, but the URL is a click tracker → still blocked.
    const items = [{
      label: 'cr_spoof',
      trackers: [{ url: 'https://ad.doubleclick.net/ddm/trackclk/B1.2', format: 'url-image' as const, dsps: 'all' as const, role: 'verification' as const }],
    }];
    expect(auditTrackerBilling(items)[0].kind).toBe('click-as-impression');
  });

  it('handles empty/missing tracker lists', () => {
    expect(auditTrackerBilling([{ label: 'x', trackers: [] }])).toHaveLength(0);
    expect(auditTrackerBilling([])).toHaveLength(0);
  });

  it('formats a block message', () => {
    const msg = formatBillingBlock([
      { label: 'a', url: 'u', kind: 'click-as-impression', severity: 'block', detail: '' },
    ]);
    expect(msg).toContain('1 tracker');
    expect(msg).toContain('click→impressão');
  });
});

import { trackerBlockReason } from '@/services/activation/billing-guard';

describe('trackerBlockReason — human confirmation', () => {
  it('passes an unknown tracker once confirmed', () => {
    expect(trackerBlockReason({ url: 'https://newvendor.example.com/p/123', format: 'url-image', dsps: 'all' })).toBe('unknown-purpose');
    expect(trackerBlockReason({ url: 'https://newvendor.example.com/p/123', format: 'url-image', dsps: 'all', confirmed: true })).toBeNull();
  });

  it('NEVER lets confirmed override a click URL (re-derives)', () => {
    expect(trackerBlockReason({ url: 'https://ad.doubleclick.net/ddm/trackclk/B1.2', format: 'url-image', dsps: 'all', confirmed: true })).toBe('click-as-impression');
  });

  it('passes impression/verification regardless of confirmed', () => {
    expect(trackerBlockReason({ url: 'https://tps.doubleverify.com/v.gif', format: 'url-image', dsps: 'all' })).toBeNull();
    expect(trackerBlockReason({ url: 'https://ad.example.com/trackimp/p.gif', format: 'url-image', dsps: 'all' })).toBeNull();
  });

  it('auditTrackerBilling respects confirmed for unknowns', () => {
    const conf = auditTrackerBilling([{ label: 'c', trackers: [{ url: 'https://x.example.com/p/1', format: 'url-image', dsps: 'all', confirmed: true }] }]);
    expect(conf).toHaveLength(0);
  });
});

import { trackerFiresOnImpression } from '@/services/activation/billing-guard';

describe('trackerBlockReason — video/event awareness', () => {
  const clk = (eventType?: string): Tracker => ({ url: 'https://ad.doubleclick.net/ddm/trackclk/B1.2', format: 'url-image', dsps: 'all', eventType: eventType as Tracker['eventType'] });

  it('display click always fires on impression → blocked', () => {
    expect(trackerBlockReason(clk(), false)).toBe('click-as-impression');
  });

  it('video click on the CLICK event does not fire on impression → passes', () => {
    expect(trackerFiresOnImpression(clk('click'), true)).toBe(false);
    expect(trackerBlockReason(clk('click'), true)).toBeNull();
  });

  it('video click with no event (defaults impression) → blocked', () => {
    expect(trackerBlockReason(clk(undefined), true)).toBe('click-as-impression');
  });

  it('video click explicitly on impression event → blocked', () => {
    expect(trackerBlockReason(clk('impression'), true)).toBe('click-as-impression');
  });

  it('auditTrackerBilling skips a legit video click-event tracker', () => {
    expect(auditTrackerBilling([{ label: 'v', isVideo: true, trackers: [clk('click')] }])).toHaveLength(0);
  });
});
