import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';
import type { AssetEntry, ActivationResult } from '@/types';
import { uploadAssetToStorage, buildCreativePayload, uploadThumbnail } from '@/services/storage';

interface DV360AssetConfig {
  advertiserId: string;
  campaignName: string;
  advertiserName: string;
  brandName: string;
}

/**
 * Activate asset creatives in DV360 via dsp-dv360-asset.
 * Videos go 1 at a time with 3s delay (transcoding is serial per advertiser).
 * Display/HTML5 go in chunks of 5.
 *
 * Ported from legacy: async function activateDV360Assets(token) — lines 1453-1527
 */
export async function activateDV360Assets(
  token: string,
  assets: AssetEntry[],
  config: DV360AssetConfig,
  onProgress?: (current: number, total: number, msg: string) => void,
): Promise<ActivationResult> {
  try {
    if (!assets.length) {
      return { dsp: 'DV360', status: 'error', detail: 'Nenhum asset pra ativar' };
    }

    const total = assets.length;

    // Build payloads with already-uploaded storagePaths + thumbnails
    const creatives: Array<ReturnType<typeof buildCreativePayload> & { _uploadError?: string; thumbnailUrl?: string }> = [];
    for (let i = 0; i < total; i++) {
      const a = assets[i];
      try {
        if (!a._storagePath) {
          await uploadAssetToStorage(a, token, (msg) =>
            onProgress?.(i, total, msg)
          );
        }
        const payload = buildCreativePayload(a, 'dv360');
        // Upload thumbnail
        let thumbnailUrl = '';
        if (a.thumb) {
          thumbnailUrl = await uploadThumbnail(a.thumb, token);
        }
        creatives.push({ ...payload, thumbnailUrl });
      } catch (err) {
        creatives.push({
          ...buildCreativePayload(a, 'dv360'),
          _uploadError: (err as Error).message,
        });
      }
    }

    const videoCreatives = creatives.filter((c) => !c._uploadError && c.type === 'video');
    const otherCreatives = creatives.filter((c) => !c._uploadError && c.type !== 'video');
    const errorCreatives = creatives.filter((c) => c._uploadError);

    const allResults: Array<{ name: string; success: boolean; creativeId?: string; error?: string }> = [];
    let successCount = 0;
    let processed = 0;

    // Record upload failures
    errorCreatives.forEach((c) =>
      allResults.push({ success: false, name: c.name, error: 'Upload failed: ' + c._uploadError })
    );

    // Videos: pairs of 2 with 1.5s stagger (edge function has retry for CONCURRENCY)
    const VIDEO_PARALLEL = 2;
    for (let i = 0; i < videoCreatives.length; i += VIDEO_PARALLEL) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const batch = videoCreatives.slice(i, i + VIDEO_PARALLEL);
      const batchPromises = batch.map((vc, bi) => {
        const idx = i + bi;
        processed++;
        onProgress?.(processed, total, `Criando video ${idx + 1}/${videoCreatives.length} na DV360: ${vc.name}`);
        return fetch(`${SUPABASE_FUNCTIONS_URL}/dsp-dv360-asset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            advertiserId: config.advertiserId,
            campaignName: config.campaignName,
            advertiserName: config.advertiserName,
            brandName: config.brandName,
            creatives: [vc],
          }),
        }).then(async (res) => {
          const data = await res.json();
          for (const r of data.results || []) {
            allResults.push(r);
            if (r.success) successCount++;
          }
        }).catch((err) => {
          allResults.push({
            success: false,
            name: vc.name,
            error: (err as Error).message || 'Network error',
          });
        });
      });
      await Promise.all(batchPromises);
    }

    // Display/HTML5: chunks of 5
    const CHUNK = 5;
    for (let i = 0; i < otherCreatives.length; i += CHUNK) {
      const chunk = otherCreatives.slice(i, i + CHUNK);
      processed += chunk.length;
      onProgress?.(processed, total, `Criando display ${Math.min(i + CHUNK, otherCreatives.length)}/${otherCreatives.length} na DV360...`);

      try {
        const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/dsp-dv360-asset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            advertiserId: config.advertiserId,
            campaignName: config.campaignName,
            advertiserName: config.advertiserName,
            brandName: config.brandName,
            creatives: chunk,
          }),
        });
        const data = await res.json();
        for (const r of data.results || []) {
          allResults.push(r);
          if (r.success) successCount++;
        }
      } catch (chunkErr) {
        for (const c of chunk) {
          allResults.push({
            success: false,
            name: c.name,
            error: (chunkErr as Error).message || 'Network error',
          });
        }
      }
    }

    return {
      dsp: 'DV360',
      status: successCount === allResults.length ? 'success' : successCount > 0 ? 'partial' : 'error',
      detail: `${successCount}/${allResults.length} criativos criados`,
      results: allResults,
    };
  } catch (err) {
    return { dsp: 'DV360', status: 'error', detail: (err as Error).message || 'Erro de conexão' };
  }
}
