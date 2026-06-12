/**
 * Audit tests — fixtures mirror real production row shapes verified via SQL
 * on 2026-06-12 (Listerine CM360 3P tags, Stayfree DV360 VAST, Kenvue survey
 * iframes, Heineken legacy string-array trackers, double-encoded dsp_config).
 */
import { describe, it, expect } from 'vitest';
import { groupsToParsedData, parseTrackers } from '@/services/duplicate';
import type { CreativeGroup, DspDetail } from '@/types';

function makeDsp(overrides: Partial<DspDetail> = {}): DspDetail {
  return {
    id: 'uuid-1', dsp_creative_id: '12345', audit_status: 'approved',
    click_url: null, landing_page: null, js_tag: null, vast_tag: null,
    sync_error: null, dsp_config: null, trackers: null, ...overrides,
  };
}

function makeGroup(overrides: Partial<CreativeGroup> = {}): CreativeGroup {
  return {
    _gid: 'g0', name: 'X', dimensions: '300x250', creative_type: 'display',
    asset_filename: null, asset_mime_type: null, thumbnail_url: null,
    js_tag: null, created_by_name: 'T', created_at: '2026-06-01T00:00:00Z',
    last_edited_at: null, last_edited_by: null, dsps: {}, ...overrides,
  };
}

const CM360_TAG = `<ins class='dcmads' style='display:inline-block;width:300px;height:250px' data-dcm-placement='N266802.3844866HYPR/B35709427.446797576' data-dcm-rendering-mode='script' data-dcm-click-tracker='\${CLICK_URL}' data-dcm-https-only></ins>`;
const DCLK_JUMP = 'https://ad.doubleclick.net/ddm/jump/N266802.3844866HYPR/B35709427.446797576;sz=300x250;dc_tdv=1';
const VAST_URL = 'https://ad.doubleclick.net/ddm/pfadx/N266802.3844866HYPR/B35981084.448752885;sz=0x0;ord=[timestamp];dc_vast=4;gdpr=${GDPR}';
const SURVEY_IFRAME = '<iframe src="https://form.typeform.com/to/tcGLC41s" width="300" height="600" frameborder="0" style="border:0;" allowfullscreen></iframe>';

describe('parseTrackers — shapes verified in production', () => {
  it('handles modern Tracker-object arrays serialized as JSONB string', () => {
    const raw = JSON.stringify([{ url: 'https://trk.com/i', format: 'url-image', dsps: 'all' }]);
    const out = parseTrackers(raw);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://trk.com/i');
  });

  it('handles legacy string-array trackers (Heineken Apr/2026 rows) without crashing', () => {
    const raw = JSON.stringify(['https://secure.adnxs.com/seg?t=2&add=42535675']);
    const out = parseTrackers(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      url: 'https://secure.adnxs.com/seg?t=2&add=42535675',
      format: 'url-image',
      dsps: 'all',
    });
  });

  it('infers url-js format for legacy .js tracker strings', () => {
    const out = parseTrackers(JSON.stringify(['https://cdn.example/pixel.js?x=1']));
    expect(out[0].format).toBe('url-js');
  });

  it('handles empty-string-array shape ("[]") and null', () => {
    expect(parseTrackers('[]')).toEqual([]);
    expect(parseTrackers(null)).toEqual([]);
  });

  it('drops malformed entries instead of crashing', () => {
    const raw = JSON.stringify([null, 42, { notUrl: true }, 'https://ok.com/p.png', { url: 'https://obj.com', format: 'url-image', dsps: ['xandr'] }]);
    const out = parseTrackers(raw);
    expect(out).toHaveLength(2);
    expect(out[0].url).toBe('https://ok.com/p.png');
    expect(out[1].dsps).toEqual(['xandr']);
  });

  it('preserves eventType on video trackers', () => {
    const raw = JSON.stringify([{ url: 'https://t.com/v', format: 'url-image', dsps: 'all', eventType: 'completion' }]);
    expect(parseTrackers(raw)[0].eventType).toBe('completion');
  });
});

describe('groupsToParsedData — production row shapes', () => {
  it('CM360 3P tag (Listerine shape): tag preserved verbatim, doubleclick jump click_url intact', () => {
    const g = makeGroup({
      name: 'Listerine|...|300x250|HYPR-HYBRID-LISTERINE-DISPLAY|F000O1MP',
      dsps: {
        dv360: makeDsp({ js_tag: CM360_TAG, click_url: DCLK_JUMP, landing_page: DCLK_JUMP, trackers: '"[]"' as unknown as string }),
      },
    });
    const { parsed, skipped } = groupsToParsedData([g], '_v2');
    expect(skipped).toHaveLength(0);
    const p = parsed!.placements[0];
    expect(p.jsTag).toBe(CM360_TAG); // byte-identical — nothing rewrites the tag
    expect(p.clickUrl).toBe(DCLK_JUMP);
    expect(p.type).toBe('display');
  });

  it('DV360 VAST (Stayfree shape): null click_url/landing_page → video placement with empty clickUrl', () => {
    const g = makeGroup({
      creative_type: 'video',
      dimensions: '1280x720',
      dsps: { dv360: makeDsp({ vast_tag: VAST_URL }) },
    });
    const { parsed, skipped } = groupsToParsedData([g], '_v2');
    expect(skipped).toHaveLength(0);
    const p = parsed!.placements[0];
    expect(p.type).toBe('video');
    expect(p.vastTag).toBe(VAST_URL);
    expect(p.clickUrl).toBe(''); // StepActivate allows empty clickUrl for video
  });

  it('Survey (Kenvue JNJ Baby shape): typeform iframe rehydrates as display tag placement', () => {
    const g = makeGroup({
      name: 'HYPR_KENVUE_JNJ_BABY-PROMO_SHOPPINGS_CONTROLE_JUN26',
      dimensions: '300x600',
      dsps: { dv360: makeDsp({ js_tag: SURVEY_IFRAME, click_url: 'https://hypr.mobi', landing_page: 'https://hypr.mobi' }) },
    });
    const { parsed } = groupsToParsedData([g], '_v2');
    const p = parsed!.placements[0];
    expect(p.jsTag).toBe(SURVEY_IFRAME);
    expect(p.placementName).toBe('HYPR_KENVUE_JNJ_BABY-PROMO_SHOPPINGS_CONTROLE_JUN26_v2');
    expect(p.clickUrl).toBe('https://hypr.mobi');
  });

  it('group with legacy string trackers duplicates without crashing (was a TypeError before fix)', () => {
    const g = makeGroup({
      name: '2_HNK_verde_300x600_Grupo-Mateus',
      dsps: {
        xandr: makeDsp({
          js_tag: '<div>tag</div>',
          click_url: 'https://heineken.com',
          trackers: '["https://secure.adnxs.com/seg?t=2&add=42535675"]' as unknown as string,
        }),
      },
    });
    const { parsed, skipped } = groupsToParsedData([g], '_v2');
    expect(skipped).toHaveLength(0);
    expect(parsed!.placements[0].trackers).toHaveLength(1);
    expect(parsed!.placements[0].trackers[0].dsps).toBe('all');
  });
});
