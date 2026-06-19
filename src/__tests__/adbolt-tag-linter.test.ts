import { describe, it, expect } from 'vitest';
import { lintTag, lintPlacement } from '@/lib/adbolt-tag-linter';
import { platformToken } from '@/lib/dsp-config';

// Real CM360 display tag shape exported for the Listerine campaign: rendering
// mode is already 'script', but data-dcm-click-tracker is absent.
const LISTERINE_DISPLAY = `<ins class='dcmads' style='display:inline-block;width:728px;height:90px'
    data-dcm-placement='N266802.3844866HYPR/B36042009.448409545'
    data-dcm-rendering-mode='script'
    data-dcm-https-only
    data-dcm-ltd='false'
    data-dcm-app-id=''>
  <script src='https://www.googletagservices.com/dcm/dcmads.js'></script>
</ins>`;

const LISTERINE_PLACEMENT_NAME = 'Listerine|ListerinePro|ListerinePro|AWA|PG|CPM|HYPR|NVF|DISP';

describe('platformToken', () => {
  it('reads HYPR house token as neutral', () => {
    expect(platformToken(LISTERINE_PLACEMENT_NAME)).toBe('neutral');
  });
  it('reads DV360 token', () => {
    expect(platformToken('Brand|AWA|DV360|300x250')).toBe('dv360');
  });
  it('returns null when no token present', () => {
    expect(platformToken('Brand_Generic_300x250')).toBeNull();
  });
});

describe('rule 1 — missing click tracker (display)', () => {
  it('flags the Listerine tag and injects the click macro', () => {
    const r = lintTag({ tag: LISTERINE_DISPLAY, targetDSP: 'dv360', placementName: LISTERINE_PLACEMENT_NAME });
    expect(r.tipo).toBe('display');
    expect(r.status).toBe('fixed');
    expect(r.issues.some((i) => i.code === 'missing-click-tracker' && i.autofix)).toBe(true);
    expect(r.tagCorrigida).toContain("data-dcm-click-tracker='${CLICK_URL}'");
    // keeps rendering-mode script, doesn't duplicate the tracker
    expect((r.tagCorrigida!.match(/data-dcm-click-tracker/g) || []).length).toBe(1);
    expect(r.tagCorrigida).toContain("data-dcm-rendering-mode='script'");
  });

  it('is idempotent — a fixed tag lints clean', () => {
    const first = lintTag({ tag: LISTERINE_DISPLAY, targetDSP: 'dv360', placementName: LISTERINE_PLACEMENT_NAME });
    const second = lintTag({ tag: first.tagCorrigida!, targetDSP: 'dv360', placementName: LISTERINE_PLACEMENT_NAME });
    expect(second.status).toBe('ok');
    expect(second.tagCorrigida).toBeNull();
  });

  it('forces rendering-mode to script when wrong', () => {
    const tag = LISTERINE_DISPLAY.replace("rendering-mode='script'", "rendering-mode='iframe'");
    const r = lintTag({ tag, targetDSP: 'xandr', placementName: 'x|HYPR|y' });
    expect(r.tagCorrigida).toContain("data-dcm-rendering-mode='script'");
    expect(r.tagCorrigida).not.toContain("iframe");
  });

  it('auto-fixed blocker does NOT block the push', () => {
    const r = lintTag({ tag: LISTERINE_DISPLAY, targetDSP: 'dv360', placementName: LISTERINE_PLACEMENT_NAME });
    expect(r.status).not.toBe('blocked');
  });
});

describe('rule 2 — platform mismatch', () => {
  it('blocks a DV360 placement pushed to Xandr', () => {
    const tag = LISTERINE_DISPLAY.replace('HYPR', 'DV360');
    const r = lintTag({ tag, targetDSP: 'xandr', placementName: 'Brand|AWA|DV360|300x250' });
    expect(r.status).toBe('blocked');
    expect(r.issues.some((i) => i.code === 'platform-mismatch' && i.nivel === 'bloqueia' && !i.autofix)).toBe(true);
  });

  it('does not block a DV360 placement pushed to DV360', () => {
    const r = lintTag({ tag: LISTERINE_DISPLAY, targetDSP: 'dv360', placementName: 'Brand|AWA|DV360|300x250' });
    expect(r.issues.some((i) => i.code === 'platform-mismatch')).toBe(false);
  });

  it('does not block a neutral HYPR placement on any DSP', () => {
    const r = lintTag({ tag: LISTERINE_DISPLAY, targetDSP: 'xandr', placementName: LISTERINE_PLACEMENT_NAME });
    expect(r.issues.some((i) => i.code === 'platform-mismatch')).toBe(false);
  });
});

describe('rule 3 — VAST ord cachebuster (Xandr only)', () => {
  const VAST_URL = "https://ad.doubleclick.net/ddm/pfadx/N123/B456;sz=0x0;ord=[timestamp]";

  it('rewrites ord for Xandr', () => {
    const r = lintTag({ tag: VAST_URL, targetDSP: 'xandr', placementName: 'x|HYPR|y' });
    expect(r.tipo).toBe('video');
    expect(r.tagCorrigida).toContain('ord=${CACHEBUSTER}');
    expect(r.issues.some((i) => i.code === 'vast-ord-cachebuster')).toBe(true);
  });

  it('leaves ord untouched for DV360', () => {
    const r = lintTag({ tag: VAST_URL, targetDSP: 'dv360', placementName: 'x|HYPR|y' });
    expect(r.tagCorrigida).toBeNull();
    expect(r.issues.some((i) => i.code === 'vast-ord-cachebuster')).toBe(false);
  });
});

describe('rule 4 — VAST content flags (never auto-fixed)', () => {
  it('flags missing MediaFile and bad duration, never produces a fix', () => {
    const xml = `<VAST version="3.0"><Ad><InLine><Creatives><Creative><Linear>
      <Duration>00:00:00</Duration></Linear></Creative></Creatives></InLine></Ad></VAST>`;
    const r = lintTag({ tag: 'https://ad.doubleclick.net/pfadx/x;ord=${CACHEBUSTER}', targetDSP: 'xandr', placementName: 'x|HYPR|y', vastXml: xml });
    expect(r.status).toBe('blocked');
    expect(r.flagsCM360.some((f) => f.code === 'vast-no-mediafile')).toBe(true);
    expect(r.flagsCM360.some((f) => f.code === 'vast-bad-duration')).toBe(true);
    expect(r.tagCorrigida).toBeNull();
  });

  it('passes a healthy VAST', () => {
    const xml = `<VAST version="3.0"><Ad><InLine><Creatives><Creative><Linear>
      <Duration>00:00:15</Duration>
      <MediaFiles><MediaFile type="video/mp4">https://cdn.example.com/v.mp4</MediaFile></MediaFiles>
      <VideoClicks><ClickThrough>https://brand.example.com</ClickThrough></VideoClicks>
      </Linear></Creative></Creatives></InLine></Ad></VAST>`;
    const r = lintTag({ tag: 'https://ad.doubleclick.net/pfadx/x;ord=${CACHEBUSTER}', targetDSP: 'xandr', placementName: 'x|HYPR|y', vastXml: xml });
    expect(r.status).toBe('ok');
    expect(r.flagsCM360.length).toBe(0);
  });
});

describe('lintPlacement — multi-DSP merge', () => {
  it('accumulates click tracker (agnostic) across DV360 + Xandr without duplicates', () => {
    const r = lintPlacement(
      { placementName: LISTERINE_PLACEMENT_NAME, type: 'display', jsTag: LISTERINE_DISPLAY, vastTag: '' },
      ['dv360', 'xandr'],
    );
    expect(r.status).toBe('fixed');
    expect((r.tagCorrigida!.match(/data-dcm-click-tracker/g) || []).length).toBe(1);
    expect(r.issues.filter((i) => i.code === 'missing-click-tracker').length).toBe(1);
  });

  it('runs DSP-agnostic rule 1 even with no DSP selected', () => {
    const r = lintPlacement(
      { placementName: LISTERINE_PLACEMENT_NAME, type: 'display', jsTag: LISTERINE_DISPLAY, vastTag: '' },
      [],
    );
    expect(r.issues.some((i) => i.code === 'missing-click-tracker')).toBe(true);
  });
});
