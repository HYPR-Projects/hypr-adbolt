import { describe, it, expect } from 'vitest';
import { genDV360 } from '@/generators/dv360';
import { genXandr } from '@/generators/xandr';
import { genStackAdapt } from '@/generators/stackadapt';
import { genAmazonDSP } from '@/generators/amazon';
import type { Placement } from '@/types';

const DISPLAY_PLACEMENTS: Placement[] = [
  {
    placementId: '1', placementName: 'Banner_300x250', dimensions: '300x250',
    jsTag: '<script src="https://ad.example.com/1"></script>', clickUrl: 'https://brand.com',
    type: 'display', vastTag: '', trackers: [],
  },
  {
    placementId: '2', placementName: 'Banner_728x90', dimensions: '728x90',
    jsTag: '<script src="https://ad.example.com/2"></script>', clickUrl: 'https://brand.com',
    type: 'display', vastTag: '', trackers: [],
  },
];

const VIDEO_PLACEMENT: Placement = {
  placementId: '3', placementName: 'Video_1920x1080', dimensions: '1920x1080',
  jsTag: '', clickUrl: '', type: 'video',
  vastTag: 'https://ad.example.com/vast/3.xml', trackers: [],
};

const MIXED = [...DISPLAY_PLACEMENTS, VIDEO_PLACEMENT];

describe('genDV360', () => {
  it('generates correct CSV headers', () => {
    const result = genDV360(DISPLAY_PLACEMENTS);
    expect(result.type).toBe('csv');
    expect(result.headers[0]).toBe('Creative name');
    expect(result.headers).toContain('Third-party tag');
  });

  it('splits display and video counts', () => {
    const result = genDV360(MIXED);
    expect(result.displayCount).toBe(2);
    expect(result.videoCount).toBe(1);
    expect(result.rows).toHaveLength(3);
  });

  it('formats dimensions as "W x H" for display', () => {
    const result = genDV360(DISPLAY_PLACEMENTS);
    expect(result.rows[0][1]).toBe('300 x 250');
  });

  it('creates separate files for display and video', () => {
    const result = genDV360(MIXED);
    expect(result.files).toBeDefined();
    expect(result.files!.display.rows).toHaveLength(2);
    expect(result.files!.video.rows).toHaveLength(1);
  });
});

describe('genXandr', () => {
  it('generates correct XLSX headers', () => {
    const result = genXandr(DISPLAY_PLACEMENTS, '', false);
    expect(result.type).toBe('xlsx');
    expect(result.headers).toEqual([
      'Creative Name', 'Secure Content', 'Size', 'Trackers', 'External Identifier', 'Political Declaration',
    ]);
  });

  it('sets political declaration correctly', () => {
    const noPol = genXandr(DISPLAY_PLACEMENTS, '', false);
    expect(noPol.rows[0][5]).toBe('No');

    const pol = genXandr(DISPLAY_PLACEMENTS, '', true);
    expect(pol.rows[0][5]).toBe('Yes; non-EU');
  });

  it('includes tracking pixel when provided', () => {
    const placements: Placement[] = [{
      ...DISPLAY_PLACEMENTS[0],
      trackers: [{ url: 'https://existing.com/pixel', format: 'url-image', dsps: 'all' }],
    }];
    const result = genXandr(placements, 'https://global.com/pixel', false);
    expect(result.rows[0][3]).toContain('https://global.com/pixel');
    expect(result.rows[0][3]).toContain('https://existing.com/pixel');
  });
});

describe('genStackAdapt', () => {
  it('filters out 336x280', () => {
    const placements: Placement[] = [
      ...DISPLAY_PLACEMENTS,
      { ...DISPLAY_PLACEMENTS[0], placementId: '99', dimensions: '336x280' },
    ];
    const { file, excluded } = genStackAdapt(placements, 'Brand', '');
    expect(file.rows).toHaveLength(2);
    expect(excluded).toBe(1);
  });

  it('includes brand name column', () => {
    const { file } = genStackAdapt(DISPLAY_PLACEMENTS, 'LeroyMerlin', '');
    expect(file.rows[0][4]).toBe('LeroyMerlin');
  });
});

describe('genAmazonDSP', () => {
  it('excludes video placements', () => {
    const result = genAmazonDSP(MIXED, 'ADV123', 'BR');
    expect(result.rows).toHaveLength(2); // Only display
  });

  it('sets correct marketplace and language', () => {
    const result = genAmazonDSP(DISPLAY_PLACEMENTS, 'ADV123', 'BR');
    expect(result.rows[0][3]).toBe('BR');
    expect(result.rows[0][4]).toBe('Portuguese');
  });

  it('uses correct sheet name', () => {
    const result = genAmazonDSP(DISPLAY_PLACEMENTS, 'ADV123', 'US');
    expect(result.sheetName).toBe('THIRD-PARTY DISPLAY');
    expect(result.rows[0][4]).toBe('English');
  });

  it('uses the exact Creative Template dropdown value', () => {
    // Amazon DSP bulk upload rejects any value that does not match the
    // dropdown exactly. "Third party" without "-Display" silently drops
    // the creative during import.
    const result = genAmazonDSP(DISPLAY_PLACEMENTS, 'ADV123', 'BR');
    expect(result.rows[0][1]).toBe('Third-party Display');
    expect(result.rows[1][1]).toBe('Third-party Display');
  });

  it('defaults click destination to "Links to another website"', () => {
    const result = genAmazonDSP(DISPLAY_PLACEMENTS, 'ADV123', 'BR');
    expect(result.rows[0][9]).toBe('Links to another website');
  });

  it('detects Amazon destination via clickUrl (amazon.com.br)', () => {
    const p: Placement[] = [{
      placementId: '1', placementName: 'Colgate_COLT_300x250', dimensions: '300x250',
      jsTag: '<script src="https://ad.doubleclick.net/x"></script>',
      clickUrl: 'https://www.amazon.com.br/colgate-total',
      type: 'display', vastTag: '', trackers: [],
    }];
    const result = genAmazonDSP(p, 'ADV123', 'BR');
    expect(result.rows[0][9]).toBe('Links to an Amazon website');
  });

  it('detects Amazon destination across ccTLDs and subdomains', () => {
    const hosts = [
      'https://amazon.com/dp/B0X',
      'https://www.amazon.co.uk/foo',
      'https://amazon.de/bar',
      'https://primevideo.com/detail/abc',
      'https://www.audible.com/pd/x',
      'https://a.co/d/shortlink',
    ];
    for (const url of hosts) {
      const p: Placement[] = [{
        placementId: '1', placementName: 'p', dimensions: '300x250',
        jsTag: '', clickUrl: url, type: 'display', vastTag: '', trackers: [],
      }];
      const result = genAmazonDSP(p, '', 'BR');
      expect(result.rows[0][9]).toBe('Links to an Amazon website');
    }
  });

  it('does not falsely match amazon-lookalike or tracker domains', () => {
    const hosts = [
      'https://amazon-ads.com/pixel',
      'https://tracker.not-amazon.com/px',
      'https://myamazon.fake/x',
      'https://amazoncolgate.com/',
    ];
    for (const url of hosts) {
      const p: Placement[] = [{
        placementId: '1', placementName: 'p', dimensions: '300x250',
        jsTag: '', clickUrl: url, type: 'display', vastTag: '', trackers: [],
      }];
      const result = genAmazonDSP(p, '', 'BR');
      expect(result.rows[0][9]).toBe('Links to another website');
    }
  });

  it('falls back to extracting click destination from jsTag when clickUrl is empty', () => {
    const p: Placement[] = [{
      placementId: '1', placementName: 'p', dimensions: '300x250',
      jsTag: '<a data-cta-url="https://www.amazon.com.br/colgate" href="#"><img src="x"/></a>',
      clickUrl: '', type: 'display', vastTag: '', trackers: [],
    }];
    const result = genAmazonDSP(p, '', 'BR');
    expect(result.rows[0][9]).toBe('Links to an Amazon website');
  });

  // DCM tags wrap the real landing URL in an opaque ad.doubleclick.net
  // redirect that Amazon DSP does not follow at upload time. Even when
  // the creative name signals Amazon (ODSP, AMZ, etc.), declaring
  // "Links to an Amazon website" causes Amazon DSP to silently drop
  // the creative during bulk import. The safe, import-compatible
  // value in every DCM case is "Links to another website" —
  // Amazon DSP validates the actual click destination in runtime via
  // the redirect, independent of this column.
  it('keeps "another website" for DCM-wrapped tags even with Amazon name markers', () => {
    const dcmTag = "<ins class='dcmads' data-dcm-placement='N1433191.4242296HYPRN/B35590397.444842262'></ins>";
    const dcmRedirect = 'https://ad.doubleclick.net/ddm/jump/N1433191.4242296HYPRN/B35590397.444842262';
    const names = [
      'M6621748_ODSP_COLT_Whitening_P_D_STD_CPM_300x250',
      'AMZ_Banner_300x250_Prime_Day',
      'Campaign_AMAZON_300x250',
      'ADSP_Campaign_Q4_300x250',
      'AMZN_RetailBrand_728x90',
    ];
    for (const name of names) {
      const p: Placement[] = [{
        placementId: '1', placementName: name, dimensions: '300x250',
        jsTag: dcmTag, clickUrl: dcmRedirect,
        type: 'display', vastTag: '', trackers: [],
      }];
      const result = genAmazonDSP(p, '', 'BR');
      expect(result.rows[0][9]).toBe('Links to another website');
    }
  });
});
