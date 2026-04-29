/* ══════════════════════════════════════════════
   UI types — wizard, assets, dashboard grouping
   ══════════════════════════════════════════════ */

import type { AssetType, Tracker } from './domain';
import type { AuditStatus } from './db';

// ── Asset (upload form entry — in-memory, pre-activation) ──

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
  html5Content?: string;
  resized?: boolean;
  // ── Video-specific metadata (populated by analyzeVideo) ──
  bitrateKbps?: number;
  videoCodec?: string;
  videoStatus?: 'ok' | 'warn' | 'fail';
  videoWarnings?: string[];
  // ── Storage cache ──
  _storagePath?: string;
  _uploadedFile?: File;
  _uploadedFileHash?: string;
  _thumbnailUrl?: string;
  _html5PreviewUrl?: string;
}

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
  thumbnail_url: string | null;
  js_tag: string | null;
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
