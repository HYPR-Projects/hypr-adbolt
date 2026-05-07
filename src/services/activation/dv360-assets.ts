import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';
import type { AssetEntry, ActivationResult } from '@/types';
import { buildCreativePayload, uploadThumbnail, uploadHtml5Preview } from '@/services/storage';
import { fetchWithRetry } from './retry';
import type { TokenProvider } from '@/lib/auth-token';

interface DV360AssetConfig {
  advertiserId: string;
  campaignName: string;
  advertiserName: string;
  brandName: string;
}

/**
 * Activate asset creatives in DV360 via dsp-dv360-asset.
 * Videos go 1 at a time with 4s delay (transcoding is serial per advertiser).
 * Display/HTML5 go in chunks of 5.
 *
 * `getToken` é uma factory que retorna o access_token atual da sessão
 * (sempre fresco, vide src/lib/auth-token.ts). É chamado antes de cada
 * upload/ativação pra garantir que loops longos não usem token expirado.
 */
export async function activateDV360Assets(
  getToken: TokenProvider,
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
      // Phase 1 deve ter feito upload de todos os assets. Se chegou aqui sem
      // _storagePath, é porque Phase 1 falhou pra esse asset — não tenta
      // re-uploadar (gerava 40s+ de delay por asset quebrado, prolongando o
      // batch inteiro). Marca como erro e segue.
      if (!a._storagePath) {
        creatives.push({
          ...buildCreativePayload(a, 'dv360'),
          _uploadError: 'Asset não foi enviado pro storage (Phase 1 falhou). Re-tente a ativação.',
        });
        continue;
      }
      try {
        const payload = buildCreativePayload(a, 'dv360');
        // Token fresco a cada asset — uploads de thumbnail/preview podem
        // levar segundos cada e o loop como um todo pode passar de 1h.
        const token = await getToken();
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

    // Videos: 100% serial com 4s de delay entre vídeos novos. Paralelismo
    // aqui satura o transcoder do DV360 por advertiser e retorna
    // "No mediaId: Internal Error" silencioso.
    //
    // Retry é feito AQUI no frontend (não no edge function) para que cada
    // tentativa seja em um isolate fresco do Deno - elimina risco de OOM
    // por estado acumulado dentro de uma mesma execução do edge function.
    // Backoff: 6s, 15s, 30s entre tentativas. Detecta erro transiente
    // tanto em data.results[].error quanto em status HTTP do response.
    const VIDEO_PARALLEL = 1;
    const VIDEO_STAGGER_MS = 4000;
    const VIDEO_RETRY_DELAYS_MS = [6000, 15000, 30000];
    const isTransientError = (msg: string): boolean =>
      /internal error|timeout|unavailable|try again|worker.*limit|memory/i.test(msg);

    const callDV360 = async (vc: typeof videoCreatives[number]) => {
      const token = await getToken();
      const res = await fetchWithRetry(`${SUPABASE_FUNCTIONS_URL}/dsp-dv360-asset`, {
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
      });
      if (!res.ok) {
        return { httpStatus: res.status, results: [] as Array<{ name: string; success: boolean; creativeId?: string; error?: string }> };
      }
      const data = await res.json();
      return { httpStatus: res.status, results: (data.results || []) as Array<{ name: string; success: boolean; creativeId?: string; error?: string }> };
    };

    for (let i = 0; i < videoCreatives.length; i += VIDEO_PARALLEL) {
      if (i > 0) await new Promise((r) => setTimeout(r, VIDEO_STAGGER_MS));
      const batch = videoCreatives.slice(i, i + VIDEO_PARALLEL);
      const batchPromises = batch.map(async (vc, bi) => {
        const idx = i + bi;
        processed++;
        onProgress?.(processed, total, `Criando video ${idx + 1}/${videoCreatives.length} na DV360: ${vc.name}`);

        let lastResult: { name: string; success: boolean; creativeId?: string; error?: string } | null = null;
        for (let attempt = 0; attempt <= VIDEO_RETRY_DELAYS_MS.length; attempt++) {
          if (attempt > 0) {
            const delay = VIDEO_RETRY_DELAYS_MS[attempt - 1];
            console.warn(`[dv360] Retry ${attempt}/${VIDEO_RETRY_DELAYS_MS.length} for ${vc.name} after ${delay}ms (last: ${lastResult?.error?.substring(0, 100) || 'http error'})`);
            onProgress?.(processed, total, `Retry ${attempt} para ${vc.name}...`);
            await new Promise((r) => setTimeout(r, delay));
          }
          try {
            const { httpStatus, results } = await callDV360(vc);
            // HTTP error transiente (546 worker limit, 5xx do Supabase)
            if (httpStatus >= 500) {
              lastResult = { success: false, name: vc.name, error: `HTTP ${httpStatus}` };
              if (attempt < VIDEO_RETRY_DELAYS_MS.length) continue;
              allResults.push(lastResult);
              return;
            }
            // Edge function respondeu 2xx - inspeciona resultados
            const r = results[0];
            if (r?.success) {
              allResults.push(r);
              successCount++;
              return;
            }
            lastResult = r || { success: false, name: vc.name, error: 'Empty response' };
            if (attempt < VIDEO_RETRY_DELAYS_MS.length && isTransientError(lastResult.error || '')) {
              continue;
            }
            allResults.push(lastResult);
            return;
          } catch (err) {
            lastResult = { success: false, name: vc.name, error: (err as Error).message || 'Network error' };
            if (attempt < VIDEO_RETRY_DELAYS_MS.length) continue;
            allResults.push(lastResult);
            return;
          }
        }
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
        // Token fresco por chunk — em batches grandes, esse loop pode
        // passar do tempo de vida do JWT inicial.
        const token = await getToken();
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
