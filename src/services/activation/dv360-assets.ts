import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';
import type { AssetEntry, ActivationResult } from '@/types';
import { uploadAssetToStorage, buildCreativePayload, uploadThumbnail, uploadHtml5Preview } from '@/services/storage';
import { fetchWithRetry } from './retry';

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
  activationSessionId?: string,
): Promise<ActivationResult> {
  try {
    if (!assets.length) {
      return { dsp: 'DV360', status: 'error', detail: 'Nenhum asset pra ativar' };
    }

    const total = assets.length;

    // Build payloads with already-uploaded storagePaths + thumbnails
    const creatives: Array<ReturnType<typeof buildCreativePayload> & { _uploadError?: string; thumbnailUrl?: string; html5PreviewUrl?: string }> = [];
    for (let i = 0; i < total; i++) {
      const a = assets[i];
      try {
        if (!a._storagePath) {
          await uploadAssetToStorage(a, token, (msg) =>
            onProgress?.(i, total, msg)
          );
        }
        const payload = buildCreativePayload(a, 'dv360');
        // Use pre-uploaded URLs from Phase 1, fallback to upload here
        let thumbnailUrl = a._thumbnailUrl || '';
        if (!thumbnailUrl && a.thumb) {
          thumbnailUrl = await uploadThumbnail(a.thumb, token);
        }
        let html5PreviewUrl = a._html5PreviewUrl || '';
        if (!html5PreviewUrl && a.type === 'html5' && a.html5Content) {
          html5PreviewUrl = await uploadHtml5Preview(a.html5Content, token);
        }
        creatives.push({ ...payload, thumbnailUrl, html5PreviewUrl });
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

    // Videos: 100% serial com 4s de delay. Paralelismo aqui satura o transcoder
    // do DV360 por advertiser e retorna "No mediaId: Internal Error" silencioso.
    // Edge function tem retry no upload, mas mesmo assim o ideal é não ofender
    // o rate limit do Google. 1 vídeo por chamada, 1 chamada por vez.
    const VIDEO_PARALLEL = 1;
    const VIDEO_STAGGER_MS = 4000;
    for (let i = 0; i < videoCreatives.length; i += VIDEO_PARALLEL) {
      if (i > 0) await new Promise((r) => setTimeout(r, VIDEO_STAGGER_MS));
      const batch = videoCreatives.slice(i, i + VIDEO_PARALLEL);
      const batchPromises = batch.map((vc, bi) => {
        const idx = i + bi;
        processed++;
        onProgress?.(processed, total, `Criando video ${idx + 1}/${videoCreatives.length} na DV360: ${vc.name}`);
        return fetchWithRetry(`${SUPABASE_FUNCTIONS_URL}/dsp-dv360-asset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            advertiserId: config.advertiserId,
            campaignName: config.campaignName,
            advertiserName: config.advertiserName,
            brandName: config.brandName,
            activationSessionId: activationSessionId || null,
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
        const res = await fetchWithRetry(`${SUPABASE_FUNCTIONS_URL}/dsp-dv360-asset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            advertiserId: config.advertiserId,
            campaignName: config.campaignName,
            advertiserName: config.advertiserName,
            brandName: config.brandName,
            activationSessionId: activationSessionId || null,
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
