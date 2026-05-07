import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';
import type { Placement, ActivationResult } from '@/types';
import { mergeTrackers } from '@/parsers/tracker';
import { fetchWithRetry } from './retry';

/**
 * Activate 3P display tag creatives on Amazon DSP via the dsp-amazon edge function.
 *
 * Scope: Phase 3 covers display 3P tags only. Video VAST and direct asset
 * uploads are routed elsewhere or marked as "not supported yet" by the edge
 * function itself — the service forwards everything and surfaces what comes
 * back.
 *
 * Note that, unlike DV360 / Xandr, the advertiser is fixed (HYPR's DSP advertiser
 * 4968167560201) — there's no per-call advertiserId. The edge function reads
 * it from dsp_amazon_credentials.
 */
export async function activateAmazonDspTags(
  token: string,
  placements: Placement[],
  config: { campaignName: string; advertiserName: string; brandName?: string; sourceType?: 'tags' | 'surveys' },
  activationSessionId?: string,
): Promise<ActivationResult> {
  try {
    if (!placements.length) {
      return { dsp: 'Amazon DSP', status: 'error', detail: 'Nenhum criativo pra ativar' };
    }

    const body = {
      campaignName: config.campaignName,
      advertiserName: config.advertiserName,
      brandName: config.brandName || null,
      sourceType: config.sourceType || 'tags',
      activationSessionId: activationSessionId || null,
      creatives: placements.map((p) => ({
        name: p.placementName,
        dimensions: p.dimensions,
        jsTag: p.jsTag,
        clickUrl: p.clickUrl || '',
        type: p.type || 'display',
        vastTag: p.vastTag || '',
        trackers: mergeTrackers(p.trackers || [], 'amazondsp'),
      })),
    };

    const res = await fetchWithRetry(`${SUPABASE_FUNCTIONS_URL}/dsp-amazon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      return { dsp: 'Amazon DSP', status: 'error', detail: data.error || 'Erro na requisição' };
    }

    return {
      dsp: 'Amazon DSP',
      status: data.status,
      detail: `${data.success}/${data.total} criativos criados`,
      results: data.results,
    };
  } catch (err) {
    return { dsp: 'Amazon DSP', status: 'error', detail: (err as Error).message || 'Erro de conexão' };
  }
}
