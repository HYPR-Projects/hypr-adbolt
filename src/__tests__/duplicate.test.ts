import { describe, it, expect } from 'vitest';
import { detectGroupKind, groupsToParsedData } from '@/services/duplicate';
import type { CreativeGroup, DspDetail } from '@/types';

function makeDsp(overrides: Partial<DspDetail> = {}): DspDetail {
  return {
    id: 'uuid-1',
    dsp_creative_id: '12345',
    audit_status: 'approved',
    click_url: null,
    landing_page: null,
    js_tag: null,
    vast_tag: null,
    sync_error: null,
    dsp_config: null,
    trackers: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<CreativeGroup> = {}): CreativeGroup {
  return {
    _gid: 'g0_test',
    name: 'HYPR_Test_300x600',
    dimensions: '300x600',
    creative_type: 'display',
    asset_filename: null,
    asset_mime_type: null,
    thumbnail_url: null,
    js_tag: null,
    created_by_name: 'Tester',
    created_at: '2026-06-01T00:00:00Z',
    last_edited_at: null,
    last_edited_by: null,
    dsps: {},
    ...overrides,
  };
}

describe('detectGroupKind', () => {
  it('classifies groups with asset_filename as asset', () => {
    expect(detectGroupKind(makeGroup({ asset_filename: 'banner.png' }))).toBe('asset');
  });

  it('classifies tag/VAST/survey groups (no asset file) as tag', () => {
    expect(detectGroupKind(makeGroup())).toBe('tag');
  });
});

describe('groupsToParsedData', () => {
  it('builds placements from persisted js_tag with suffix, click_url and trackers', () => {
    const g = makeGroup({
      dsps: {
        xandr: makeDsp({
          js_tag: '<script src="https://ad.example/tag.js"></scr' + 'ipt>',
          click_url: 'https://brand.com/lp',
          trackers: JSON.stringify([{ url: 'https://trk.example/imp', format: 'url-image', dsps: 'all' }]),
        }),
      },
    });

    const { parsed, skipped } = groupsToParsedData([g], '_v2');
    expect(skipped).toHaveLength(0);
    expect(parsed).not.toBeNull();
    expect(parsed!.placements).toHaveLength(1);
    const p = parsed!.placements[0];
    expect(p.placementName).toBe('HYPR_Test_300x600_v2');
    expect(p.dimensions).toBe('300x600');
    expect(p.clickUrl).toBe('https://brand.com/lp');
    expect(p.type).toBe('display');
    expect(p.trackers).toHaveLength(1);
    expect(p.trackers[0].url).toBe('https://trk.example/imp');
    expect(parsed!.contentType).toBe('display');
  });

  it('prefers xandr as canonical DSP over dv360', () => {
    const g = makeGroup({
      dsps: {
        dv360: makeDsp({ js_tag: '<div>dv</div>', click_url: 'https://dv.com' }),
        xandr: makeDsp({ js_tag: '<div>xn</div>', click_url: 'https://xn.com' }),
      },
    });
    const { parsed } = groupsToParsedData([g], '');
    expect(parsed!.placements[0].clickUrl).toBe('https://xn.com');
    expect(parsed!.placements[0].jsTag).toBe('<div>xn</div>');
  });

  it('maps VAST creatives to video placements', () => {
    const g = makeGroup({
      creative_type: 'video',
      dsps: { xandr: makeDsp({ vast_tag: 'https://vast.example/tag.xml' }) },
    });
    const { parsed } = groupsToParsedData([g], '_v2');
    expect(parsed!.placements[0].type).toBe('video');
    expect(parsed!.placements[0].vastTag).toBe('https://vast.example/tag.xml');
    expect(parsed!.contentType).toBe('video');
  });

  it('skips groups without any persisted tag and reports reason', () => {
    const g = makeGroup({ dsps: { xandr: makeDsp() } });
    const { parsed, skipped } = groupsToParsedData([g], '_v2');
    expect(parsed).toBeNull();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].name).toBe('HYPR_Test_300x600');
  });

  it('falls back to landing_page when click_url is empty and parses tracker arrays passed as objects', () => {
    const g = makeGroup({
      dsps: {
        dv360: makeDsp({
          js_tag: '<div>tag</div>',
          landing_page: 'https://fallback.com',
          trackers: [{ url: 'https://t.com/1', format: 'url-js', dsps: ['dv360'] }],
        }),
      },
    });
    const { parsed } = groupsToParsedData([g], '');
    expect(parsed!.placements[0].clickUrl).toBe('https://fallback.com');
    expect(parsed!.placements[0].trackers[0].dsps).toEqual(['dv360']);
  });

  it('generates unique placementIds so mergeParsedData never dedupes duplicates away', () => {
    const groups = [
      makeGroup({ _gid: 'a', name: 'A', dsps: { xandr: makeDsp({ js_tag: '<div>a</div>' }) } }),
      makeGroup({ _gid: 'b', name: 'B', dsps: { xandr: makeDsp({ js_tag: '<div>b</div>' }) } }),
    ];
    const { parsed } = groupsToParsedData(groups, '_v2');
    const ids = parsed!.placements.map((p) => p.placementId);
    expect(new Set(ids).size).toBe(2);
  });
});
