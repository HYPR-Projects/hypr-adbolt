import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';
import { DSP_DEFAULTS } from '@/lib/dsp-config';
import type { AssetEntry, ActivationResult } from '@/types';
import { uploadAssetToStorage, buildCreativePayload, uploadThumbnail, uploadHtml5Preview } from '@/services/storage';

interface XandrAssetConfig {
  brandUrl: string;
  languageId: number;
  brandId: string;
  sla: number;
}

/**
 * Activate asset creatives in Xandr one-by-one via dsp-xandr-asset.
 * Ported from legacy: async function activateXandrAssets(token) — lines 1405-1451
 */
export async function activateXandrAssets(
  token: string,
  assets: AssetEntry[],
  config: XandrAssetConfig,
  onProgress?: (current: number, total: number, msg: string) => void,
): Promise<ActivationResult> {
  try {
    if (!assets.length) {
      return { dsp: 'Xandr', status: 'error', detail: 'Nenhum asset pra ativar' };
    }

    const results: Array<{ name: string; success: boolean; creativeId?: string; error?: string }> = [];

    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      onProgress?.(i, assets.length, `Criando ${i + 1}/${assets.length} na Xandr: ${a.name}`);

      try {
        const prepared = buildCreativePayload(a, 'xandr');
        if (!prepared.storagePath) {
          await uploadAssetToStorage(a, token, (msg) =>
            onProgress?.(i, assets.length, msg)
          );
          Object.assign(prepared, buildCreativePayload(a, 'xandr'));
        }

        // Use pre-uploaded URLs from Phase 1, fallback to upload here
        let thumbnailUrl = (a as any)._thumbnailUrl || '';
        if (!thumbnailUrl && a.thumb) {
          thumbnailUrl = await uploadThumbnail(a.thumb, token);
        }

        let html5PreviewUrl = (a as any)._html5PreviewUrl || '';
        if (!html5PreviewUrl && a.type === 'html5' && a.html5Content) {
          html5PreviewUrl = await uploadHtml5Preview(a.html5Content, token);
        }

        const body = {
          advertiserId: DSP_DEFAULTS.xandr.advertiserId,
          brandUrl: config.brandUrl || null,
          languageId: config.languageId,
          brandId: config.brandId ? parseInt(config.brandId) : null,
          sla: config.sla,
          creatives: [{ ...prepared, thumbnailUrl, html5PreviewUrl }],
        };

        const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/dsp-xandr-asset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        if (res.ok && data.results?.length) {
          results.push(...data.results);
        } else {
          results.push({ name: a.name, success: false, error: data.error || 'Erro' });
        }
      } catch (err) {
        results.push({ name: a.name, success: false, error: (err as Error).message });
      }

      onProgress?.(i + 1, assets.length, `✓ ${i + 1}/${assets.length}`);
    }

    const successCount = results.filter((r) => r.success).length;
    return {
      dsp: 'Xandr',
      status: successCount === results.length ? 'success' : successCount > 0 ? 'partial' : 'error',
      detail: `${successCount}/${results.length} criativos criados`,
      results,
    };
  } catch (err) {
    return { dsp: 'Xandr', status: 'error', detail: (err as Error).message || 'Erro de conexão' };
  }
}
