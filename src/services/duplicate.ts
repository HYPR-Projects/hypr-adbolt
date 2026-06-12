/**
 * Duplicate service — rehydrates wizard state from already-activated creatives.
 *
 * Strategy: duplication is NOT a server-side clone. It rebuilds the in-memory
 * wizard payload (ParsedData for tags/VAST/surveys, AssetEntry[] for assets)
 * from persisted creative rows, then the user flows through the normal wizard
 * (edit names/URLs/trackers → pick DSPs → config → activate). The activation
 * pipeline is untouched, so duplicates are real new creatives with new rows,
 * new dsp_creative_ids and normal sync.
 */

import { supabase } from './supabase';
import { requireCdnLib } from '@/lib/cdn-loader';
import { getAssetType, generateThumb, readFileDimensions } from '@/lib/asset-processing';
import { analyzeVideo } from '@/lib/video-analysis';
import { processHTML5Zip } from '@/lib/html5-zip';
import { analyzeTracker } from '@/parsers/tracker';
import type {
  CreativeGroup, DspDetail, Placement, ParsedData, Tracker, AssetEntry,
} from '@/types';

export type DuplicateKind = 'tag' | 'asset';

export interface SkippedGroup {
  name: string;
  reason: string;
}

/** Asset = has a stored file; everything else (3P tag, VAST, survey) rehydrates as a tag placement. */
export function detectGroupKind(g: CreativeGroup): DuplicateKind {
  return g.asset_filename ? 'asset' : 'tag';
}

/**
 * Trackers come from JSONB and exist in three persisted shapes (verified in prod):
 * 1. Array of Tracker objects (or its JSON-string form): [{url, format, dsps, eventType?}]
 * 2. Legacy array of plain URL strings: ["https://..."] — pre-Tracker-object era
 * 3. Empty: [] / null
 * Normalizes everything into Tracker[]; malformed entries are dropped, never crash.
 */
export function parseTrackers(raw: Tracker[] | string | null): Tracker[] {
  if (!raw) return [];
  let list: unknown = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];

  const out: Tracker[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      // Legacy format: plain URL string → infer format, scope to all DSPs
      const t = item.trim();
      if (!t) continue;
      const { url, format } = analyzeTracker(t);
      out.push({ url, format, dsps: 'all' });
    } else if (item && typeof item === 'object' && typeof (item as Tracker).url === 'string') {
      const t = item as Partial<Tracker> & { url: string };
      out.push({
        url: t.url,
        format: t.format || 'url-image',
        dsps: t.dsps === 'all' || Array.isArray(t.dsps) ? t.dsps : 'all',
        ...(t.eventType ? { eventType: t.eventType } : {}),
      });
    }
    // anything else (number, null, nested garbage) is silently dropped
  }
  return out;
}

/**
 * Pick the canonical DspDetail for a group. Per-DSP rows can diverge slightly
 * (e.g. click_url edited on one DSP only); prefer xandr → dv360 → first.
 */
function pickCanonicalDsp(g: CreativeGroup): DspDetail | null {
  return g.dsps.xandr || g.dsps.dv360 || Object.values(g.dsps)[0] || null;
}

function parseDspConfig(raw: DspDetail['dsp_config'] | string | null): Record<string, unknown> {
  if (!raw) return {};
  let v: unknown = raw;
  // Prod has double-encoded rows (JSONB string containing a JSON string) — unwrap up to 2 levels
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Scan all DSP rows of a group for a persisted storage_path. */
function getStoragePath(g: CreativeGroup): string | null {
  for (const d of Object.values(g.dsps)) {
    const cfg = parseDspConfig(d.dsp_config);
    if (typeof cfg.storage_path === 'string' && cfg.storage_path) return cfg.storage_path;
  }
  return null;
}

/** Deep-copy a tracker so the duplicate never shares array references with dashboard state. */
function cloneTrackers(trackers: Tracker[]): Tracker[] {
  return trackers.map((t) => ({ ...t, dsps: t.dsps === 'all' ? 'all' : [...t.dsps] }));
}

// ══════════════════════════════════════════════
// Tags / VAST / Surveys → ParsedData
// ══════════════════════════════════════════════

export function groupsToParsedData(
  groups: CreativeGroup[],
  suffix: string,
): { parsed: ParsedData | null; skipped: SkippedGroup[] } {
  const skipped: SkippedGroup[] = [];
  const placements: Placement[] = [];

  groups.forEach((g, i) => {
    const canonical = pickCanonicalDsp(g);
    if (!canonical) {
      skipped.push({ name: g.name, reason: 'sem dados de DSP persistidos' });
      return;
    }

    const jsTag = canonical.js_tag || g.js_tag || '';
    const vastTag = canonical.vast_tag || '';
    if (!jsTag && !vastTag) {
      skipped.push({ name: g.name, reason: 'sem tag persistida (js_tag/vast_tag vazios)' });
      return;
    }

    const isVideo = g.creative_type === 'video' || (!!vastTag && !jsTag);
    placements.push({
      placementId: `dup_${Date.now()}_${i}`,
      placementName: g.name + suffix,
      dimensions: g.dimensions || '',
      jsTag,
      clickUrl: canonical.click_url || canonical.landing_page || '',
      type: isVideo ? 'video' : 'display',
      vastTag,
      trackers: cloneTrackers(parseTrackers(canonical.trackers)),
    });
  });

  if (!placements.length) return { parsed: null, skipped };

  const hasDisplay = placements.some((p) => p.type === 'display');
  const hasVideo = placements.some((p) => p.type === 'video');

  return {
    parsed: {
      advertiserName: '',
      campaignName: '',
      brandName: '',
      placements,
      contentType: hasDisplay && hasVideo ? 'mixed' : hasVideo ? 'video' : 'display',
      sourceFormat: 'duplicate',
    },
    skipped,
  };
}

// ══════════════════════════════════════════════
// Assets → AssetEntry[] (re-downloads from storage)
// ══════════════════════════════════════════════

async function downloadAssetFile(g: CreativeGroup, storagePath: string): Promise<File> {
  const { data, error } = await supabase.storage
    .from('asset-uploads')
    .download(storagePath);
  if (error || !data) {
    throw new Error(error?.message || 'download falhou');
  }
  const filename = g.asset_filename || storagePath.split('/').pop() || 'asset';
  const mime = g.asset_mime_type || data.type || 'application/octet-stream';
  return new File([data], filename, { type: mime });
}

export async function groupsToAssetEntries(
  groups: CreativeGroup[],
  suffix: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ entries: AssetEntry[]; skipped: SkippedGroup[] }> {
  const skipped: SkippedGroup[] = [];
  const entries: AssetEntry[] = [];
  let nextId = 0;

  // Pre-load JSZip only if any HTML5 zip is in the selection
  const hasZip = groups.some((g) => g.asset_filename?.toLowerCase().endsWith('.zip'));
  if (hasZip) {
    await requireCdnLib('JSZip');
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const canonical = pickCanonicalDsp(g);
    const storagePath = getStoragePath(g);

    if (!storagePath) {
      skipped.push({ name: g.name, reason: 'sem storage_path (criativo anterior à feature de cache de assets)' });
      onProgress?.(i + 1, groups.length);
      continue;
    }

    try {
      const file = await downloadAssetFile(g, storagePath);
      const prefill = {
        name: g.name + suffix,
        landingPage: canonical?.landing_page || canonical?.click_url || '',
        trackers: cloneTrackers(parseTrackers(canonical?.trackers ?? null)),
      };

      if (file.name.toLowerCase().endsWith('.zip')) {
        const html5 = await processHTML5Zip(file);
        if (!html5) {
          skipped.push({ name: g.name, reason: 'ZIP sem index.html válido' });
          onProgress?.(i + 1, groups.length);
          continue;
        }
        entries.push({ ...html5, ...prefill, id: ++nextId });
      } else {
        const type = getAssetType(file);
        if (!type) {
          skipped.push({ name: g.name, reason: `formato não suportado (${file.name})` });
          onProgress?.(i + 1, groups.length);
          continue;
        }
        const thumb = await generateThumb(file, type);
        if (type === 'video') {
          const v = await analyzeVideo(file);
          entries.push({
            id: ++nextId,
            type,
            file,
            originalFile: file,
            ...prefill,
            dimensions: `${v.w}x${v.h}`,
            w: v.w,
            h: v.h,
            duration: v.duration,
            size: file.size,
            thumb,
            compressed: false,
            compressedFile: null,
            bitrateKbps: v.bitrateKbps,
            videoCodec: v.codec,
            videoStatus: v.status,
            videoWarnings: v.warnings,
          });
        } else {
          const dims = await readFileDimensions(file, type);
          entries.push({
            id: ++nextId,
            type,
            file,
            originalFile: file,
            ...prefill,
            dimensions: `${dims.w}x${dims.h}`,
            w: dims.w,
            h: dims.h,
            duration: dims.duration || 0,
            size: file.size,
            thumb,
            compressed: false,
            compressedFile: null,
          });
        }
      }
    } catch (err) {
      skipped.push({ name: g.name, reason: (err as Error).message });
    }
    onProgress?.(i + 1, groups.length);
  }

  return { entries, skipped };
}
