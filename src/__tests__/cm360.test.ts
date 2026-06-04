import { describe, it, expect } from 'vitest';
import { parseCM360 } from '@/parsers/cm360';

// Simulate a CM360 export spreadsheet structure
const CM360_FIXTURE: string[][] = [
  ['Contract Information', '', '', '', '', '', '', '', ''],
  ['Advertiser Name', 'PUB_HYPR_BR_LeroyMerlin', '', '', '', '', '', '', ''],
  ['Campaign Name', 'LeroyMerlin | Q2 2025 Awareness', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', ''],
  // Header row
  ['Placement ID', 'Placement Name', 'Advertiser Name', 'Placement Compatibility', 'Dimensions', 'JavaScript Tag', 'Internal Redirect Tag', '', ''],
  // Data rows
  ['12345', 'LM_Banner_300x250_Homepage', 'PUB_HYPR_BR_LeroyMerlin', 'Display', '300x250', '<script src="https://ad.doubleclick.net/ddm/adj/N1234.HYPR/B12345;sz=300x250;dc_trk_cid=12345" data-dcm-placement="N1234.HYPR/B12345"></script>', '', '', ''],
  ['12346', 'LM_Banner_728x90_ROS', 'PUB_HYPR_BR_LeroyMerlin', 'Display', '728x90', '<script src="https://ad.doubleclick.net/ddm/adj/N1234.HYPR/B12346;sz=728x90"></script>', '', '', ''],
  ['12347', 'LM_Video_1920x1080_PreRoll', 'PUB_HYPR_BR_LeroyMerlin', 'In-stream Video', 'N/A', '', '', '', ''],
];

// Add VAST column for the video row
CM360_FIXTURE[4].push('VAST 4.0 Pre-Fetch Tag');
CM360_FIXTURE[5].push('');
CM360_FIXTURE[6].push('');
CM360_FIXTURE[7].push('https://ad.doubleclick.net/ddm/pfadx/N1234.HYPR/B12347;sz=0x0;dc_trk_cid=12347;dcmt=text/xml');

describe('parseCM360', () => {
  it('parses a valid CM360 export', () => {
    const result = parseCM360(CM360_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.placements).toHaveLength(3);
    expect(result!.advertiserName).toBe('PUB_HYPR_BR_LeroyMerlin');
    expect(result!.campaignName).toBe('LeroyMerlin | Q2 2025 Awareness');
    expect(result!.brandName).toBe('LeroyMerlin');
  });

  it('correctly identifies display placements', () => {
    const result = parseCM360(CM360_FIXTURE)!;
    const display = result.placements.filter((p) => p.type === 'display');
    expect(display).toHaveLength(2);
    expect(display[0].dimensions).toBe('300x250');
    expect(display[0].placementName).toBe('LM_Banner_300x250_Homepage');
    expect(display[0].jsTag).toContain('doubleclick.net');
    expect(display[1].dimensions).toBe('728x90');
  });

  it('correctly identifies video placements', () => {
    const result = parseCM360(CM360_FIXTURE)!;
    const video = result.placements.filter((p) => p.type === 'video');
    expect(video).toHaveLength(1);
    expect(video[0].type).toBe('video');
    expect(video[0].vastTag).toContain('dcmt=text/xml');
    // Dimensions should be extracted from placement name since column says N/A
    expect(video[0].dimensions).toBe('1920x1080');
  });

  it('detects mixed content type', () => {
    const result = parseCM360(CM360_FIXTURE)!;
    expect(result.contentType).toBe('mixed');
  });

  it('returns null for non-CM360 data', () => {
    const garbage = [['foo', 'bar'], ['baz', 'qux']];
    expect(parseCM360(garbage)).toBeNull();
  });

  it('returns null for empty placements', () => {
    const headerOnly: string[][] = [
      ['Placement ID', 'Placement Name', 'Dimensions', 'JavaScript Tag'],
    ];
    expect(parseCM360(headerOnly)).toBeNull();
  });

  it('initializes empty trackers array', () => {
    const result = parseCM360(CM360_FIXTURE)!;
    result.placements.forEach((p) => {
      expect(p.trackers).toEqual([]);
    });
  });
});

// HYPR re-export: header at row 7, renamed tag columns, an unnamed iframe-tag
// column, empty 'Standard Tag', and ${CLICK_URL} macros instead of a click col.
const HYPR_REEXPORT: string[][] = [
  ['', '', '', '', '', '', '', '', '', 'Tag DV360 (script + ${CLICK_URL})', 'Tag Xandr (iframe + ${CLICK_URL}, sem macros Google)'],
  ['', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', ''],
  // Header row (index 6 → row 7)
  ['', 'Placement ID', 'Site', 'Placement Name', 'Placement Compatibility', 'Dimensions', 'Start Date', 'End Date', 'Standard Tag', 'Tag Corrigido DV360 (script + click macro)', ''],
  // Data rows
  ['', '447896893', 'Hypr', 'BR|PT|JohnsonsBaby|DISP|3P', 'Display', '320x480', '2026-05-01', '2026-06-30', '',
    "<ins class='dcmads' style='display:inline-block;width:320px;height:480px' data-dcm-placement='N266802.3844866HYPR/B35441728.447896893' data-dcm-rendering-mode='script' data-dcm-click-tracker='${CLICK_URL}'><script src='https://www.googletagservices.com/dcm/dcmads.js'></script></ins>",
    "<ins class='dcmads' style='display:inline-block;width:320px;height:480px' data-dcm-placement='N266802.3844866HYPR/B35441728.447896893' data-dcm-rendering-mode='iframe' data-dcm-click-tracker='${CLICK_URL}'><script src='https://www.googletagservices.com/dcm/dcmads.js'></script></ins>"],
  ['', '447910513', 'Hypr', 'BR|PT|JohnsonsBaby|DISP|3P', 'Display', '970x250', '2026-05-01', '2026-06-30', '',
    "<ins class='dcmads' style='display:inline-block;width:970px;height:250px' data-dcm-placement='N266802.3844866HYPR/B35441728.447910513' data-dcm-rendering-mode='script' data-dcm-click-tracker='${CLICK_URL}'><script src='https://www.googletagservices.com/dcm/dcmads.js'></script></ins>",
    "<ins class='dcmads' style='display:inline-block;width:970px;height:250px' data-dcm-placement='N266802.3844866HYPR/B35441728.447910513' data-dcm-rendering-mode='iframe'><script src='https://www.googletagservices.com/dcm/dcmads.js'></script></ins>"],
];

describe('parseCM360 — HYPR re-export (renamed tag columns)', () => {
  it('detects placements despite a header on row 7', () => {
    const result = parseCM360(HYPR_REEXPORT);
    expect(result).not.toBeNull();
    expect(result!.placements).toHaveLength(2);
  });

  it('recognizes the renamed/headerless 3P tag columns by content', () => {
    const p = parseCM360(HYPR_REEXPORT)!.placements;
    expect(p[0].jsTag).toContain('data-dcm-placement');
    expect(p[0].jsTag).toContain('dcmads');
    expect(p[1].jsTag).toContain('970px');
  });

  it('prefers the script-mode tag over the iframe variant', () => {
    const p = parseCM360(HYPR_REEXPORT)!.placements;
    expect(p[0].jsTag).toContain("rendering-mode='script'");
  });

  it('derives the CM360 click-through URL from the placement id', () => {
    const p = parseCM360(HYPR_REEXPORT)!.placements;
    expect(p[0].clickUrl).toBe(
      'https://ad.doubleclick.net/ddm/jump/N266802.3844866HYPR/B35441728.447896893;sz=320x480;dc_tdv=1'
    );
  });

  it('reads dimensions from the Dimensions column', () => {
    const p = parseCM360(HYPR_REEXPORT)!.placements;
    expect(p[0].dimensions).toBe('320x480');
    expect(p[1].dimensions).toBe('970x250');
  });
});
