import type { ParsedData, Placement } from '@/types';
import { cleanCR, extractBrand, extractTagClickUrl } from '@/lib/utils';

const NAME_ALIASES = [
  'creative name', 'creative_name', 'name', 'placement name', 'placement_name',
  'ad name', 'creative',
  // PT/ES
  'anúncio', 'anuncio', 'anúncios', 'anuncios', 'nome', 'nome do anúncio', 'nome do anuncio',
];
const TAG_ALIASES = [
  'third-party tag', 'third_party_tag', 'tag', 'html tag', 'js tag', 'javascript tag',
  'ad tag', 'embed', 'code', 'script', 'third party tag',
  // Vendor/decorated (DoubleVerify, HYPR exports)
  'dv tag javascript', 'display tags', 'tags',
];
const DIM_ALIASES = [
  'dimensions', 'dimensions (width x height)', 'size', 'creative size', 'ad size',
  'width x height',
  // PT/ES
  'formato', 'tamanho',
];
const CLICK_ALIASES = [
  'landing page url', 'landing page', 'landing_page', 'click url', 'click_url',
  'click-through url', 'destination url', 'url',
  // PT/ES
  'url parametrizada', 'url de destino', 'url´s', 'urls',
];
const VAST_ALIASES = ['vast tag url', 'vast tag', 'vast url', 'vast_tag', 'video tag'];

// Distinctive multi-word aliases that may appear inside a decorated header
// (e.g. "DISPLAY TAGS (Use on Display Placements Only)"). Kept distinctive so
// a `contains` match can't false-positive on a short token like "tag"/"url".
const TAG_CONTAINS = ['display tags', 'dv tag javascript', 'javascript tag', 'third-party tag', 'third party tag'];
const NAME_CONTAINS = ['nome do anúncio', 'nome do anuncio'];
const DIM_CONTAINS = ['formato', 'tamanho', 'dimensions', 'creative size', 'ad size'];

// Separator / section rows that HYPR sheets interleave between data rows
// (e.g. "Linha criativa: E2E - DESCONTO PADRÃO", "Geo").
const SEPARATOR_RE = /^(linha criativa|linha|geo|seção|secao|grupo|bloco)\b/i;

/** Exact alias match first; then a `contains` pass for decorated headers. */
function matchCol(headers: string[], aliases: string[], contains: string[] = []): number {
  let idx = headers.findIndex((h) => aliases.includes(h));
  if (idx >= 0) return idx;
  if (contains.length) {
    idx = headers.findIndex((h) => contains.some((a) => h.includes(a)));
  }
  return idx;
}

/** Extract the first WxH size token from a free-text cell (e.g. "Standard IAB - Display 300x600"). */
function extractSize(raw: string): string {
  const m = raw.match(/(\d{2,4})\s*[x×]\s*(\d{2,4})/i);
  return m ? `${m[1]}x${m[2]}` : '';
}

/**
 * Parse a generic tag spreadsheet with flexible header detection.
 * Supports DV360 bulk, AdCanvas, Nexd, Celtra, Sizmek, Flashtalking, and
 * DoubleVerify (HYPR taxonomy) tag sheets.
 *
 * NOTE: trackers are intentionally left empty here. Tracker
 * extraction/classification is billing-relevant and handled in a
 * dedicated reviewed step, never auto-assigned at parse time.
 */
export function parseGenericTags(rows: string[][]): ParsedData | null {
  let headerIdx = -1;
  let colName = -1, colTag = -1, colDim = -1, colClick = -1, colVast = -1;

  // Find header row (within first 20 rows)
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i].map((c) => String(c || '').trim().toLowerCase());
    const nameIdx = matchCol(r, NAME_ALIASES, NAME_CONTAINS);
    const tagIdx = matchCol(r, TAG_ALIASES, TAG_CONTAINS);
    if (nameIdx >= 0 && tagIdx >= 0) {
      headerIdx = i;
      colName = nameIdx;
      colTag = tagIdx;
      colDim = matchCol(r, DIM_ALIASES, DIM_CONTAINS);
      colClick = matchCol(r, CLICK_ALIASES);
      colVast = matchCol(r, VAST_ALIASES);
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
    // Skip section/separator rows that landed in the name column.
    if (SEPARATOR_RE.test(name)) continue;

    const tag = cleanCR(String(row[colTag] || '').trim());
    const rawDim = colDim >= 0 ? String(row[colDim] || '').trim() : '';
    const clickRaw = colClick >= 0 ? String(row[colClick] || '').trim() : '';
    const vastRaw = colVast >= 0 ? cleanCR(String(row[colVast] || '').trim()) : '';

    // A row with no servable tag (e.g. measurement-pixel-only video rows in
    // DV sheets) cannot be trafficked — skip rather than emit an empty tag.
    if (!tag && !vastRaw) continue;

    // Resolve dimensions: pull a WxH token out of free-text "Formato" first.
    let dim = extractSize(rawDim) || rawDim.replace(/\s/g, '');
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
      if (tag.includes('doubleverify') || tag.includes('dvtp_')) sourceFormat = 'DoubleVerify';
      else if (tag.includes('adcanvas.com') || tag.includes('adcads')) sourceFormat = 'AdCanvas';
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
