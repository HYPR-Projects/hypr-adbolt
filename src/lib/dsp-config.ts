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
  amazondsp:  { template: true, api: true },
};

/**
 * Canonical platform/seat tokens that appear inside CM360 Placement Names.
 *
 * HYPR exports decorate the Placement Name with a token marking which platform
 * the placement was trafficked for (e.g. `...|HYPR|...` or `...|DV360|...`).
 * A placement designated for one platform pushed to another renders blank
 * ("Creative Is Blank") because CM360 won't return the creative outside the
 * platform it was cut for. The tag linter reads this map to catch that before
 * the push.
 *
 * `'neutral'` = multi-platform token (HYPR house tag), routes to any DSP.
 * A concrete DspType = the placement is bound to that DSP only.
 *
 * Single source of truth: extend here, never inline in the linter or UI.
 */
export const PLATFORM_TOKENS: Record<string, DspType | 'neutral'> = {
  HYPR: 'neutral',
  DV360: 'dv360',
  DV: 'dv360',
  DBM: 'dv360',
  XANDR: 'xandr',
  XN: 'xandr',
  APPNEXUS: 'xandr',
  AMAZON: 'amazondsp',
  AMZ: 'amazondsp',
  ADSP: 'amazondsp',
  STACKADAPT: 'stackadapt',
  SA: 'stackadapt',
};

/**
 * Extract the platform token from a CM360 Placement Name.
 * Splits on the usual HYPR taxonomy separators (| _ / - space) and returns the
 * first segment that matches a known token, or null if none is present.
 */
export function platformToken(placementName: string): DspType | 'neutral' | null {
  if (!placementName) return null;
  const parts = placementName.split(/[|_/\s-]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
  for (const p of parts) {
    if (p in PLATFORM_TOKENS) return PLATFORM_TOKENS[p];
  }
  return null;
}

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
