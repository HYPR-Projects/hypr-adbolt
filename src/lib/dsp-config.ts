/**
 * DSP configuration defaults.
 * Single source of truth — all services and stores reference these.
 */

import type { DspType } from '@/types';

export const DSP_DEFAULTS = {
  xandr: {
    memberId: 14843,
    advertiserId: 7392214,
  },
  dv360: {
    advertiserId: '1426474713',
    serviceAccount: 'dsp-creative-bulk@site-hypr.iam.gserviceaccount.com',
  },
  amazondsp: {
    advertiserId: '4968167560201',
    entityId: 'ENTITY1AU67WNJQTDCK',
    defaultMarketplace: 'BR',
  },
} as const;

/**
 * DSP capability matrix.
 *
 * `template` — we can generate a bulk upload file (CSV/XLSX) the user can upload
 *              manually in the DSP's own UI.
 * `api`      — we can activate creatives directly via the DSP's API (edge
 *              functions under supabase/functions/dsp-*).
 *
 * Keep this aligned with the generators registered in src/generators/index.ts
 * and the activation services under src/services/activation/.
 *
 * When adding a new DSP integration, update this mapping *first* — it is the
 * authoritative source that StepDsps, StepConfig and StepActivate all read
 * from. Without a capability flagged here, the wizard will not offer the
 * corresponding affordance.
 */
export const DSP_CAPABILITIES: Record<DspType, { template: boolean; api: boolean }> = {
  xandr:      { template: true, api: true },
  dv360:      { template: true, api: true },
  stackadapt: { template: true, api: false },
  amazondsp:  { template: true, api: false },
};

/**
 * True if any of the given DSPs supports direct API activation.
 * Used to decide whether the "Ativar Agora" affordance should appear.
 */
export function hasApiCapableDsp(dsps: Iterable<DspType>): boolean {
  for (const d of dsps) {
    if (DSP_CAPABILITIES[d]?.api) return true;
  }
  return false;
}

/**
 * Filter a set of DSPs down to those that can be activated via API.
 * Used by StepActivate when routing between API activation and
 * template-only flows.
 */
export function filterApiCapable<T extends DspType>(dsps: Iterable<T>): T[] {
  const out: T[] = [];
  for (const d of dsps) {
    if (DSP_CAPABILITIES[d]?.api) out.push(d);
  }
  return out;
}
