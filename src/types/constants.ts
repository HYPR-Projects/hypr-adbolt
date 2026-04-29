/* ══════════════════════════════════════════════
   Constants — labels, limits, IAB sizes, wizard configs
   ══════════════════════════════════════════════ */

import type { DspType, VastEventType } from './domain';
import type { WizardConfig, WizardMode } from './ui';

// ── DSP labels ──

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

// ── VAST events ──

export const VAST_EVENT_OPTIONS: { value: VastEventType; label: string; id: number }[] = [
  { value: 'impression', label: 'Impression', id: 9 },
  { value: 'start', label: 'Start', id: 2 },
  { value: 'first_quartile', label: '25% Complete', id: 5 },
  { value: 'midpoint', label: '50% Complete', id: 6 },
  { value: 'third_quartile', label: '75% Complete', id: 7 },
  { value: 'completion', label: '100% Complete', id: 8 },
  { value: 'click', label: 'Click', id: 10 },
  { value: 'skip', label: 'Skip', id: 3 },
  { value: 'error', label: 'Error', id: 4 },
];

// ── Asset DSP weight limits (bytes) ──

export const ASSET_DSP_LIMITS: Record<string, Record<string, number>> = {
  xandr: { display: 400 * 1024, video: Infinity, html5: 2 * 1024 * 1024 },
  dv360: { display: 10 * 1024 * 1024, video: Infinity, html5: 10 * 1024 * 1024 },
  stackadapt: { display: 2 * 1024 * 1024, video: Infinity, html5: 2 * 1024 * 1024 },
  amazondsp: { display: 200 * 1024, video: Infinity, html5: 200 * 1024 },
};

// ── Storage upload limit (bytes) ──
// Teto do bucket Supabase `asset-uploads`. Precisa bater com o `file_size_limit`
// configurado no Supabase Storage. Arquivos maiores recebem 413 do Supabase.
// Alinhado com o teto de vídeo do DV360 (1GB via API) — DSP ativo mais restritivo.
// Xandr aceita até 1.8GB, mas 1GB é o limite efetivo quando o criativo vai pros dois.
export const STORAGE_UPLOAD_LIMIT = 1024 * 1024 * 1024; // 1 GB

// ── Video transcoding thresholds ──
// Bitrates em kbps. Calibrados pra serving via VAST nas DSPs ativas (Xandr/DV360),
// considerando que a UI manual da Xandr transcoda automaticamente pra ~2500 kbps
// e a API não. Vídeos acima de HARD travam preview e não entregam em RTB.
export const VIDEO_BITRATE_OK_KBPS = 4000;
export const VIDEO_BITRATE_HARD_KBPS = 8000;

// Target de transcoding via ffmpeg.wasm. Bate com a recomendação da Xandr
// (1280x720 @ 2500 kbps no topo da escala suportada) e mantém compatibilidade
// com o player de qualquer publisher web/mobile.
export const VIDEO_TRANSCODE_TARGET = {
  maxWidth: 1280,
  maxHeight: 720,
  videoBitrateKbps: 2500,
  audioBitrateKbps: 128,
  profile: 'baseline' as const,
  level: '3.1' as const,
};

// Codecs aceitáveis sem transcoding obrigatório. HEVC/AV1/etc geram VAST com
// MediaFile que a maioria dos players web/mobile não decoda — força transcode.
export const VIDEO_CODECS_OK = new Set(['avc1', 'h264']);

// ── Survey sizes ──

export const SURVEY_SIZES = ['300x600', '300x250', '320x480'];

// ── Wizard configuration (steps per mode) ──

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

// ── IAB standard creative sizes ──

export const STACKADAPT_EXCLUDED_SIZES = new Set(['336x280']);

export const IAB_SIZES = new Set([
  '120x600', '160x600', '200x200', '250x250', '300x50', '300x250',
  '300x600', '320x50', '320x100', '320x480', '336x280', '468x60',
  '480x320', '728x90', '768x1024', '970x90', '970x250', '1024x768',
  '1080x1920', '1920x1080',
]);
