import { describe, it, expect } from 'vitest';
import {
  parseAssetSheet,
  classifyTrackerCell,
  extractCode,
  normalizeSize,
} from '@/parsers/asset-sheet';
import { matchAssets, type MatchAsset } from '@/lib/asset-sheet-match';

// ── Fixtures mirroring the real Hypr_Tags.xlsx (OBoticario / W3haus) ──

const PLACEMENTS: Array<[code: string, size: string, plc: string, linha: string]> = [
  ['35', '1280x720', '448716999', 'VIDEO'],
  ['35_1', '1280x960', '448717002', 'VIDEO'],
  ['36', '300x250', '448717011', 'DISPLAY'],
  ['36_1', '970x250', '448717014', 'DISPLAY'],
  ['36_2', '300x600', '448717017', 'DISPLAY'],
  ['36_3', '728x90', '448717020', 'DISPLAY'],
  ['36_4', '160x600', '448717023', 'DISPLAY'],
  ['36_5', '300x250', '448717026', 'DISPLAY'], // collides on size with 36
  ['36_6', '320x50', '448413635', 'DISPLAY'],
  ['36_7', '300x50', '448413638', 'DISPLAY'],
];

const trackimp = (plc: string) =>
  `https://ad.doubleclick.net/ddm/trackimp/N1014735.3844866HYPR/B35939394.${plc};dc_trk_aid=641934407;dc_trk_cid=255794;ord=1`;
const trackclk = (plc: string) =>
  `https://ad.doubleclick.net/ddm/trackclk/N1014735.3844866HYPR/B35939394.${plc};dc_trk_aid=641934407;dc_trk_cid=255794`;
const dvTag = (plc: string) =>
  `<script src="https://cdn.doubleverify.com/dvbm.js#ctx=22332709&cmp=35939394&sid=6716093&plc=${plc}&advid=9044157&adsrv=1"></script>`;

const NAME_PREFIX =
  'OBoticario|W3haus|AlwaysOn|ServicosDeLoja|Consideracao|Hypr|Trafego|CPC|NA|2026|All|Geolocation|Visitantes|18_64|BR|All|NA|NA|NA|NA|Display|PDOOH|NA|NA|NA|ComunicacaoGeral';

function buildSheet(): string[][] {
  const header = ['LINHA CRIATIVA', 'Tamanho', 'Anúncio ', 'Track Impre', 'Track Click', 'Double Verify'];
  const rows = PLACEMENTS.map(([code, size, plc, linha]) => [
    linha,
    size,
    `${NAME_PREFIX}|${size}|${code}`,
    trackimp(plc),
    trackclk(plc),
    dvTag(plc),
  ]);
  return [header, ...rows];
}

// Asset filenames as they arrive from the zip (without extension)
const ASSET_NAMES: Array<[name: string, dims: string, type: string]> = [
  ['cód 36.7 - 300x50', '300x50', 'display'],
  ['cód 36 - 300x250', '300x250', 'display'],
  ['cód 36.5 - 300x250', '300x250', 'display'],
  ['cód 36.3 - 728x90', '728x90', 'display'],
  ['cód 36.2 - 300x600', '300x600', 'display'],
  ['cód 36.1 - 970x250', '970x250', 'display'],
  ['cód 36.4 - 160x600', '160x600', 'display'],
  ['cód 36.6 - 320x50', '320x50', 'display'],
  ['cód 35 - 1280x720 (1)', '1280x720', 'video'],
  ['cód 35.1 - 1280x960 (1)', '1280x960', 'video'],
];

const buildAssets = (): MatchAsset[] =>
  ASSET_NAMES.map(([name, dimensions, type], i) => ({ id: i + 1, name, dimensions, type }));

describe('classifyTrackerCell', () => {
  it('routes trackimp as impression / url-image', () => {
    const t = classifyTrackerCell(trackimp('448717011'))!;
    expect(t.role).toBe('impression');
    expect(t.format).toBe('url-image');
  });
  it('routes trackclk as click', () => {
    expect(classifyTrackerCell(trackclk('448717011'))!.role).toBe('click');
  });
  it('routes DoubleVerify as verification / url-js', () => {
    const t = classifyTrackerCell(dvTag('448717011'))!;
    expect(t.role).toBe('verification');
    expect(t.format).toBe('url-js');
    expect(t.url).toContain('doubleverify.com/dvbm.js');
  });
  it('classifies by content even when columns are swapped', () => {
    // a trackclk sitting in the "impression" column is still a click
    expect(classifyTrackerCell(trackclk('1'))!.role).toBe('click');
  });
  it('ignores non-tracker cells', () => {
    expect(classifyTrackerCell('DISPLAY')).toBeNull();
    expect(classifyTrackerCell('')).toBeNull();
  });
});

describe('extractCode', () => {
  it('reads the trailing pipe segment', () => {
    expect(extractCode(`${NAME_PREFIX}|300x250|36_5`)).toBe('36.5');
    expect(extractCode(`${NAME_PREFIX}|1280x720|35`)).toBe('35');
  });
  it('reads códNN filenames', () => {
    expect(extractCode('cód 36.5 - 300x250')).toBe('36.5');
    expect(extractCode('cód 35 - 1280x720 (1)')).toBe('35');
  });
  it('does not mistake a size for a code', () => {
    expect(extractCode('300x250')).toBeNull();
  });
});

describe('parseAssetSheet', () => {
  const parsed = parseAssetSheet(buildSheet());

  it('finds the structural columns by content', () => {
    expect(parsed.sizeCol).toBe(1);
    expect(parsed.nameCol).toBe(2);
    expect(parsed.rows).toHaveLength(10);
  });

  it('extracts code, landing, trackers and placement per row', () => {
    const row = parsed.rows.find((r) => r.code === '36.5')!;
    expect(row.size).toBe('300x250');
    expect(row.placementId).toBe('448717026');
    expect(row.landing).toContain('trackclk');
    // trackers = impression + verification (click became landing)
    expect(row.trackers).toHaveLength(2);
    const roles = row.trackers.map((t) => t.role).sort();
    expect(roles).toEqual(['impression', 'verification']);
    // landing is NOT in trackers
    expect(row.trackers.some((t) => t.role === 'click')).toBe(false);
  });

  it('keeps the two 300x250 rows distinct by code', () => {
    const codes = parsed.rows.filter((r) => r.size === '300x250').map((r) => r.code).sort();
    expect(codes).toEqual(['36', '36.5']);
  });
});

describe('matchAssets', () => {
  const result = matchAssets(buildAssets(), parseAssetSheet(buildSheet()).rows);

  it('matches all 10 with nothing ambiguous or unmatched', () => {
    expect(result.matched).toHaveLength(10);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.unmatchedAssets).toHaveLength(0);
    expect(result.unmatchedRows).toHaveLength(0);
  });

  it('resolves the 300x250 collision via creative code', () => {
    const byId = new Map(result.matched.map((m) => [m.assetId, m]));
    // asset id 2 = "cód 36 - 300x250" → placement 448717011
    expect(byId.get(2)!.row.placementId).toBe('448717011');
    // asset id 3 = "cód 36.5 - 300x250" → placement 448717026
    expect(byId.get(3)!.row.placementId).toBe('448717026');
  });

  it('flags no size mismatches on clean data', () => {
    expect(result.matched.every((m) => !m.sizeMismatch)).toBe(true);
  });

  it('falls back to size when a filename carries no code', () => {
    const assets: MatchAsset[] = [{ id: 99, name: 'banner final', dimensions: '970x250', type: 'display' }];
    const rows = parseAssetSheet(buildSheet()).rows;
    const r = matchAssets(assets, rows);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].confidence).toBe('medium');
    expect(r.matched[0].row.code).toBe('36.1');
  });
});

describe('parseAssetSheet — plain landing/destination capture', () => {
  it('captures a destination URL column even without a click tracker', () => {
    const rows: string[][] = [
      ['Anuncios', 'Formato', 'Url Parametrizada'],
      ['q3_video_lanc', '300x250', 'https://www.audi.com.br/pt/models/q3?utm_source=hypr'],
      ['q3_display_lanc', '728x90', 'https://www.audi.com.br/pt/models/q3?utm_source=hypr&x=2'],
    ];
    const parsed = parseAssetSheet(rows);
    expect(parsed.landingCol).toBeGreaterThanOrEqual(0);
    expect(parsed.rows[0].landing).toContain('audi.com.br');
    // a plain landing must NOT be misfiled as an impression-firing tracker
    expect(parsed.rows[0].trackers).toHaveLength(0);
  });

  it('does not override a click-tracker landing with the destination column', () => {
    const rows: string[][] = [
      ['Name', 'Size', 'Landing', 'Tracker'],
      ['ad1', '300x250', 'https://brand.com/page', 'https://ad.doubleclick.net/ddm/trackclk/B1.2'],
    ];
    const parsed = parseAssetSheet(rows);
    // click tracker wins as the landing (existing behavior preserved)
    expect(parsed.rows[0].landing).toContain('trackclk');
  });
});
