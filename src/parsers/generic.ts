import type { ParsedData, Placement } from '@/types';
import { cleanCR, extractBrand, extractTagClickUrl } from '@/lib/utils';

const NAME_ALIASES = ['creative name', 'creative_name', 'name', 'placement name', 'placement_name', 'ad name', 'creative'];
const TAG_ALIASES = ['third-party tag', 'third_party_tag', 'tag', 'html tag', 'js tag', 'javascript tag', 'ad tag', 'embed', 'code', 'script', 'third party tag'];
const DIM_ALIASES = ['dimensions', 'dimensions (width x height)', 'size', 'creative size', 'ad size', 'width x height'];
const CLICK_ALIASES = ['landing page url', 'landing page', 'landing_page', 'click url', 'click_url', 'click-through url', 'destination url', 'url'];
const VAST_ALIASES = ['vast tag url', 'vast tag', 'vast url', 'vast_tag', 'video tag'];

/**
 * Parse a generic tag spreadsheet with flexible header detection.
 * Supports DV360 bulk, AdCanvas, Nexd, Celtra, Sizmek, Flashtalking formats.
 *
 * Ported from legacy: function parseGenericTags(rows) — lines 1802-1898
 */
export function parseGenericTags(rows: string[][]): ParsedData | null {
  let headerIdx = -1;
  let colName = -1, colTag = -1, colDim = -1, colClick = -1, colVast = -1;

  // Find header row (within first 20 rows)
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i].map((c) => String(c || '').trim().toLowerCase());
    const nameIdx = r.findIndex((c) => NAME_ALIASES.includes(c));
    const tagIdx = r.findIndex((c) => TAG_ALIASES.includes(c));
    if (nameIdx >= 0 && tagIdx >= 0) {
      headerIdx = i;
      colName = nameIdx;
      colTag = tagIdx;
      colDim = r.findIndex((c) => DIM_ALIASES.includes(c));
      colClick = r.findIndex((c) => CLICK_ALIASES.includes(c));
      colVast = r.findIndex((c) => VAST_ALIASES.includes(c));
      break;
    }
  }

  if (headerIdx === -1) return null;

  // Extract metadata from rows above header
  let campaignName = '';
  let advertiserName = '';
  let platform = '';
  let sourceFormat = 'generic';

  for (let i = 0; i < headerIdx; i++) {
    const row = rows[i];
    const key = String(row[0] || '').trim().toLowerCase();
    const val = String(row[1] || '').trim();
    if (!key || !val) continue;
    if (key.includes('campaign') && (key.includes('name') || key.includes('id'))) campaignName = val;
    else if (key.includes('advertiser')) advertiserName = val;
    else if (key === 'platform') platform = val;
    if (i === 0 && !row[1] && row[0]) campaignName = campaignName || String(row[0]).trim();
  }

  if (platform.toLowerCase().includes('dv360') || platform.toLowerCase().includes('display & video')) {
    sourceFormat = 'DV360 bulk';
  }

  // Parse placement rows
  const placements: Placement[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row[colName] || '').trim();
    if (!name) continue;

    const tag = cleanCR(String(row[colTag] || '').trim());
    const rawDim = colDim >= 0 ? String(row[colDim] || '').trim() : '';
    const clickRaw = colClick >= 0 ? String(row[colClick] || '').trim() : '';
    const vastRaw = colVast >= 0 ? cleanCR(String(row[colVast] || '').trim()) : '';

    // Resolve dimensions
    let dim = rawDim.replace(/\s/g, '');
    if ((!dim || dim === 'N/A') && tag) {
      const dw = tag.match(/data-width="(\d+)"/);
      const dh = tag.match(/data-height="(\d+)"/);
      if (dw && dh) dim = dw[1] + 'x' + dh[1];
    }
    if (!dim || dim === 'N/A') {
      const m = name.match(/(\d{2,4})x(\d{2,4})/);
      if (m) dim = m[0];
    }
    dim = dim.replace(/\s*x\s*/i, 'x');

    // Detect type
    const isVast = !!vastRaw || (tag.includes('VAST') || tag.includes('vpaid') || tag.includes('xml'));
    const isVideo = isVast && !tag.startsWith('<ins') && !tag.startsWith('<script');
    const placementType = isVideo ? 'video' as const : 'display' as const;

    // Click URL
    let clickUrl = clickRaw;
    if (!clickUrl && tag) {
      const ct = tag.match(/data-click-tracker="([^"]*)"/);
      if (ct) clickUrl = ct[1].replace(/\$\{CLICK_URL\}/g, '').replace(/\$\{CLICK_URL_ENC\}/g, '');
    }
    // HYPR AdTag: no literal landing in the tag (data-clicktag is a DSP macro);
    // fall back to the hosted creative URL in data-iframe-src.
    if (!clickUrl && tag) clickUrl = extractTagClickUrl(tag);

    // Detect source format from tag content
    if (!sourceFormat || sourceFormat === 'generic') {
      if (tag.includes('adcanvas.com') || tag.includes('adcads')) sourceFormat = 'AdCanvas';
      else if (tag.includes('nexd.com') || tag.includes('nexd')) sourceFormat = 'Nexd';
      else if (tag.includes('celtra.com')) sourceFormat = 'Celtra';
      else if (tag.includes('sizmek.com')) sourceFormat = 'Sizmek';
      else if (tag.includes('flashtalking')) sourceFormat = 'Flashtalking';
    }

    placements.push({
      placementId: 'gen_' + (i - headerIdx),
      placementName: name,
      dimensions: dim || '0x0',
      jsTag: isVideo ? (vastRaw || '') : tag,
      clickUrl,
      type: placementType,
      vastTag: isVideo ? (vastRaw || tag) : '',
      trackers: [],
    });
  }

  if (!placements.length) return null;

  const hasVideo = placements.some((p) => p.type === 'video');
  const hasDisplay = placements.some((p) => p.type === 'display');
  const contentType = hasVideo && hasDisplay ? 'mixed' : hasVideo ? 'video' : 'display';

  return {
    advertiserName,
    campaignName,
    brandName: extractBrand(advertiserName, campaignName),
    placements,
    contentType,
    sourceFormat,
  };
}
