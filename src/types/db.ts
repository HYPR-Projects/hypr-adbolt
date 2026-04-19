/* ══════════════════════════════════════════════
   Database types — shape of Supabase rows
   ══════════════════════════════════════════════ */

import type { DspType, PlacementType, Tracker } from './domain';

export type CreativeStatus = 'active' | 'paused' | 'archived' | 'error' | 'deleted';

export type AuditStatus =
  | 'approved'
  | 'pending'
  | 'partial'
  | 'rejected'
  | 'unknown'
  | 'archived'
  | 'deleted';

export interface Creative {
  id: string;
  created_at: string;
  updated_at: string;
  batch_id: string | null;
  activation_session_id: string | null;
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
  thumbnail_url: string | null;
}
