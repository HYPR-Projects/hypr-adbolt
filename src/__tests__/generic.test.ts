import { describe, it, expect } from 'vitest';
import { parseGenericTags } from '@/parsers/generic';

describe('parseGenericTags', () => {
  it('parses a basic creative name + tag spreadsheet', () => {
    const rows: string[][] = [
      ['Creative name', 'Third-party tag', 'Dimensions (width x height)'],
      ['Banner_300x250', '<script src="https://ad.example.com/banner.js"></script>', '300 x 250'],
      ['Banner_728x90', '<script src="https://ad.example.com/leaderboard.js"></script>', '728 x 90'],
    ];
    const result = parseGenericTags(rows);
    expect(result).not.toBeNull();
    expect(result!.placements).toHaveLength(2);
    expect(result!.placements[0].dimensions).toBe('300x250');
    expect(result!.placements[1].dimensions).toBe('728x90');
  });

  it('detects AdCanvas source format', () => {
    const rows: string[][] = [
      ['Name', 'Tag'],
      ['Test', '<script src="https://cdn.adcanvas.com/serve/tag.js"></script>'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.sourceFormat).toBe('AdCanvas');
  });

  it('detects Nexd source format', () => {
    const rows: string[][] = [
      ['Name', 'Tag'],
      ['Test', '<script src="https://cdn.nexd.com/serve/creative.js"></script>'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.sourceFormat).toBe('Nexd');
  });

  it('extracts dimensions from tag data attributes', () => {
    const rows: string[][] = [
      ['Creative name', 'Tag'],
      ['NoDims', '<div data-width="320" data-height="480"><script src="https://test.com/ad.js"></script></div>'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.placements[0].dimensions).toBe('320x480');
  });

  it('extracts dimensions from creative name as fallback', () => {
    const rows: string[][] = [
      ['Creative name', 'Tag'],
      ['MyAd_970x250_v2', '<script src="https://test.com/ad.js"></script>'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.placements[0].dimensions).toBe('970x250');
  });

  it('extracts click URL from column', () => {
    const rows: string[][] = [
      ['Name', 'Tag', 'Landing Page URL'],
      ['Ad1', '<script src="https://test.com"></script>', 'https://brand.com/landing'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.placements[0].clickUrl).toBe('https://brand.com/landing');
  });

  it('extracts metadata from rows above header', () => {
    const rows: string[][] = [
      ['Campaign Name', 'Q3 Branding'],
      ['Advertiser', 'MyCorp'],
      ['Creative name', 'Tag'],
      ['Ad1', '<script></script>'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.campaignName).toBe('Q3 Branding');
    expect(result!.advertiserName).toBe('MyCorp');
  });

  it('returns null for no matching headers', () => {
    expect(parseGenericTags([['foo', 'bar'], ['a', 'b']])).toBeNull();
  });

  it('returns null for header-only (no data rows)', () => {
    expect(parseGenericTags([['Creative name', 'Tag']])).toBeNull();
  });

  it('uses flexible header aliases', () => {
    // "Ad name" + "embed" should also work
    const rows: string[][] = [
      ['Ad name', 'Embed'],
      ['MyAd', '<div>ad content</div>'],
    ];
    const result = parseGenericTags(rows);
    expect(result).not.toBeNull();
    expect(result!.placements[0].placementName).toBe('MyAd');
  });
});

describe('parseGenericTags — HYPR adtag', () => {
  it('falls back to data-iframe-src as clickUrl when tag carries only the ${CLICK_URL} macro', () => {
    const hyprTag = '<script src="mraid.js"></script><div data-hypr-adtag data-iframe-src="https://platform.hypr.mobi/share/creatives/zbq5fbc6ni3wwc" data-width="300" data-height="250" data-clicktag="${CLICK_URL}" data-cb="${CACHEBUSTER}"></div><script src="https://platform.hypr.mobi/hypr-adtag.js" async></script>';
    const rows: string[][] = [
      ['Creative name', 'Tag'],
      ['HYPR_BOTICARIO_300x250', hyprTag],
    ];
    const result = parseGenericTags(rows);
    expect(result).not.toBeNull();
    const p = result!.placements[0];
    expect(p.clickUrl).toBe('https://platform.hypr.mobi/share/creatives/zbq5fbc6ni3wwc');
    expect(p.dimensions).toBe('300x250');
    expect(p.type).toBe('display');
  });

  it('spreadsheet click column still wins over the HYPR fallback', () => {
    const hyprTag = '<div data-hypr-adtag data-iframe-src="https://platform.hypr.mobi/share/creatives/abc" data-width="300" data-height="250" data-clicktag="${CLICK_URL}"></div>';
    const rows: string[][] = [
      ['Creative name', 'Tag', 'Click URL'],
      ['HYPR_300x250', hyprTag, 'https://cliente.com/lp'],
    ];
    const result = parseGenericTags(rows);
    expect(result!.placements[0].clickUrl).toBe('https://cliente.com/lp');
  });
});

describe('parseGenericTags — DoubleVerify / HYPR taxonomy sheets', () => {
  it('parses a Pepsi-style DV sheet (Anúncio + Formato + DV Tag Javascript)', () => {
    const rows: string[][] = [
      ['Campanha', 'Anúncio', 'Formato', 'Criativo', 'DV Tag Javascript', 'DV Tag - 1x1', 'DV 1x1 Tag - Video'],
      ['Pepsi_uefa', 'LABM_Display_728', '728x90', 'MEALS', '<script src="https://cdn.doubleverify.com/dvtp_src.js#cmp=DV1"></script>', '', '<img src="https://tps.doubleverify.com/v.gif">'],
      ['Pepsi_uefa', 'LABH_Display_300', '300x250', '', '<script src="https://cdn.doubleverify.com/dvtp_src.js#cmp=DV2"></script>', '', '<img src="https://tps.doubleverify.com/v.gif">'],
    ];
    const result = parseGenericTags(rows);
    expect(result).not.toBeNull();
    expect(result!.sourceFormat).toBe('DoubleVerify');
    expect(result!.placements).toHaveLength(2);
    expect(result!.placements[0].placementName).toBe('LABM_Display_728');
    expect(result!.placements[0].dimensions).toBe('728x90');
    // servable JS tag captured
    expect(result!.placements[0].jsTag).toContain('dvtp_src.js');
    // the DV 1x1 measurement pixel is imported as a verification (impression-firing) tracker
    expect(result!.placements[0].trackers).toHaveLength(1);
    expect(result!.placements[0].trackers[0].role).toBe('verification');
    expect(result!.placements[0].trackers[0].url).toContain('tps.doubleverify.com');
    // the servable script column is NOT re-added as a tracker
    expect(result!.placements[0].trackers.some((t) => t.url.includes('dvtp_src.js'))).toBe(false);
  });

  it('extracts size from free-text Formato and skips separator + tag-less rows', () => {
    const rows: string[][] = [
      ['Campanha', 'Anúncio', 'Formato', 'Criativo', 'DISPLAY TAGS (Use on Display Placements Only)', '', 'VIDEO TAGS (Use on Video Placements Only)'],
      ['Linha criativa: E2E - DESCONTO PADRÃO'],
      ['Geo'],
      ['gatorade_aware', 'lab_display_300', 'Standard IAB - Display 300x600', '', '<script src="https://cdn.doubleverify.com/dvtp_src.js"></script>', '', '<img src="https://tps.doubleverify.com/v.gif">'],
      // video row: no servable display tag, only a measurement pixel → must be skipped
      ['gatorade_consider', 'lab_video_640', 'Standard IAB - Video - 640x360 - 10s', '', '', '', '<img src="https://tps.doubleverify.com/v.gif">'],
    ];
    const result = parseGenericTags(rows);
    expect(result).not.toBeNull();
    expect(result!.placements).toHaveLength(1);
    expect(result!.placements[0].dimensions).toBe('300x600');
    expect(result!.placements[0].placementName).toBe('lab_display_300');
  });
});
