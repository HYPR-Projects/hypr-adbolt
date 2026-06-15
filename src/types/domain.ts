/* ══════════════════════════════════════════════
   Domain types — trackers, placements, DSPs
   ══════════════════════════════════════════════ */

// ── DSP ──

export type DspType = 'xandr' | 'dv360' | 'stackadapt' | 'amazondsp';

// ── Tracker ──

export type TrackerFormat = 'url-image' | 'url-js' | 'url-html' | 'raw-js';

export type TrackerScope = 'all' | DspType[];

export type VastEventType =
  | 'impression'
  | 'start'
  | 'first_quartile'
  | 'midpoint'
  | 'third_quartile'
  | 'completion'
  | 'click'
  | 'skip'
  | 'error';

export interface Tracker {
  url: string;
  format: TrackerFormat;
  dsps: TrackerScope;
  eventType?: VastEventType; // Only relevant for video creatives on Xandr
  /** Content-derived purpose (impression/click/verification/unknown). Metadata
   *  for review/audit; the billing guard re-derives at activation time. */
  role?: 'impression' | 'click' | 'verification' | 'unknown';
}

// ── Placement (from CM360 / generic parser) ──

export type ContentType = 'display' | 'video' | 'mixed';
export type PlacementType = 'display' | 'video';

export interface Placement {
  placementId: string;
  placementName: string;
  dimensions: string;
  jsTag: string;
  clickUrl: string;
  type: PlacementType;
  vastTag: string;
  trackers: Tracker[];
  isSurvey?: boolean;
}

export interface ParsedData {
  advertiserName: string;
  campaignName: string;
  brandName: string;
  placements: Placement[];
  contentType: ContentType;
  sourceFormat?: string;
}

// ── Asset ──

export type AssetType = 'display' | 'video' | 'html5';
