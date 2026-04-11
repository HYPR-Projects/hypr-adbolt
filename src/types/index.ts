/* ══════════════════════════════════════════════
   AdBolt Core Types
   Derived from runtime shapes in legacy index.html
   ══════════════════════════════════════════════ */

// ── DSP ──

export type DspType = 'xandr' | 'dv360' | 'stackadapt' | 'amazondsp';

export const DSP_LABELS: Record<DspType, string> = {
  xandr: 'Xandr',
  dv360: 'DV360',
  stackadapt: 'StackAdapt',
  amazondsp: 'Amazon DSP',
};

export const DSP_SHORT_LABELS: Record<DspType, string> = {
  xandr: 'XN',
  dv360: 'DV',
  stackadapt: 'SA',
  amazondsp: 'AZ',
};

// ── Tracker ──

export type TrackerFormat = 'url-image' | 'url-js' | 'url-html' | 'raw-js';

export type TrackerScope = 'all' | DspType[];

export interface Tracker {
  url: string;
  format: TrackerFormat;
  dsps: TrackerScope;
}

export const FORMAT_LABELS: Record<TrackerFormat, string> = {
  'url-image': 'IMG',
  'url-js': 'JS',
  'url-html': 'HTML',
  'raw-js': 'Raw JS',
};

export const FORMAT_COLORS: Record<TrackerFormat, string> = {
  'url-image': 'var(--accent)',
  'url-js': 'var(--warning)',
  'url-html': 'var(--success)',
  'raw-js': 'var(--error)',
};

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

export interface AssetEntry {
  id: number;
  type: AssetType;
  file: File;
  originalFile: File;
  name: string;
  dimensions: string;
  w: number;
  h: number;
  duration: number;
  size: number;
  thumb: string;
  landingPage: string;
  trackers: Tracker[];
  compressed: boolean;
  compressedFile: File | null;
  html5?: boolean;
  hasClickTag?: boolean;
  html5Warnings?: string[];
  resized?: boolean;
  _storagePath?: string;
  _uploadedFile?: File;
}

export const ASSET_DSP_LIMITS: Record<string, Record<string, number>> = {
  xandr: { display: 400 * 1024, video: Infinity, html5: 2 * 1024 * 1024 },
  dv360: { display: 10 * 1024 * 1024, video: Infinity, html5: 10 * 1024 * 1024 },
  stackadapt: { display: 2 * 1024 * 1024, video: Infinity, html5: 2 * 1024 * 1024 },
  amazondsp: { display: 200 * 1024, video: Infinity, html5: 200 * 1024 },
};

// ── Survey ──

export interface SurveyUrl {
  url: string;
  formId: string;
  title: string;
  variant: string; // 'Controle' | 'Exposto' | ''
}

export interface SurveyEntry {
  id: number;
  type: string;
  size: string;
  urls: SurveyUrl[];
}

export const SURVEY_SIZES = ['300x600', '300x250', '320x480'];

// ── Creative (from Supabase DB) ──

export type CreativeStatus = 'active' | 'paused' | 'archived' | 'error' | 'deleted';
export type AuditStatus = 'approved' | 'pending' | 'rejected' | 'unknown' | 'archived' | 'deleted';

export interface Creative {
  id: string;
  created_at: string;
  updated_at: string;
  batch_id: string | null;
  created_by_email: string;
  created_by_name: string | null;
  last_edited_by_email: string | null;
  last_edited_by_name: string | null;
  dsp: DspType;
  dsp_creative_id: string | null;
  name: string;
  creative_type: PlacementType | 'html5';
  dimensions: string | null;
  js_tag: string | null;
  vast_tag: string | null;
  click_url: string | null;
  landing_page: string | null;
  trackers: string | Tracker[] | null; // JSONB comes as string sometimes
  asset_filename: string | null;
  asset_mime_type: string | null;
  asset_size_bytes: number | null;
  dsp_config: string | Record<string, unknown> | null;
  status: CreativeStatus;
  audit_status: AuditStatus | null;
  last_synced_at: string | null;
  sync_error: string | null;
}

// ── Dashboard Group ──

export interface DspDetail {
  id: string;
  dsp_creative_id: string | null;
  audit_status: AuditStatus;
  click_url: string | null;
  landing_page: string | null;
  js_tag: string | null;
  vast_tag: string | null;
  sync_error: string | null;
  dsp_config: Record<string, unknown> | null;
  trackers: Tracker[] | string | null;
}

export interface CreativeGroup {
  _gid: string;
  name: string;
  dimensions: string;
  creative_type: string;
  asset_filename: string | null;
  asset_mime_type: string | null;
  created_by_name: string;
  created_at: string;
  last_edited_at: string | null;
  last_edited_by: string | null;
  dsps: Record<string, DspDetail>;
}

// ── Activation ──

export interface ActivationResult {
  dsp: string;
  status: 'success' | 'partial' | 'error' | 'pending';
  detail: string;
  results?: Array<{
    name: string;
    success: boolean;
    creativeId?: string;
    error?: string;
  }>;
}

// ── Wizard ──

export type WizardMode = 'tags' | 'surveys' | 'assets';
export type AppView = 'home' | 'wizard' | 'dashboard';

export interface WizardConfig {
  steps: string[];
  labels: string[];
  sublabels: string[];
}

export const WIZARD_CONFIGS: Record<WizardMode, WizardConfig> = {
  tags: {
    steps: ['tags', 'dsps', 'config', 'activate'],
    labels: ['Embeds & Tags', 'DSPs', 'Config', 'Gerar & Ativar'],
    sublabels: ['Arquivo CM360', 'Destino', 'Marca e opções', 'Templates'],
  },
  surveys: {
    steps: ['surveys', 'dsps', 'config', 'activate'],
    labels: ['Surveys', 'DSPs', 'Config', 'Gerar & Ativar'],
    sublabels: ['URLs Typeform', 'Destino', 'Marca e opções', 'Templates'],
  },
  assets: {
    steps: ['assets', 'dsps', 'config', 'activate'],
    labels: ['Standard Assets', 'DSPs', 'Config', 'Ativar'],
    sublabels: ['Upload mídia', 'Destino', 'Marca e opções', 'Ativação'],
  },
};

export const MODE_LABELS: Record<WizardMode, string> = {
  tags: 'Embeds & Tags',
  surveys: 'Surveys',
  assets: 'Standard Assets',
};

// ── Misc ──

export const STACKADAPT_EXCLUDED_SIZES = new Set(['336x280']);

export const IAB_SIZES = new Set([
  '120x600', '160x600', '200x200', '250x250', '300x50', '300x250',
  '300x600', '320x50', '320x100', '320x480', '336x280', '468x60',
  '480x320', '728x90', '768x1024', '970x90', '970x250', '1024x768',
  '1080x1920', '1920x1080',
]);
