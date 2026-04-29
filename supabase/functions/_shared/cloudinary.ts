/**
 * Cloudinary integration — transcode de vídeos pra Xandr/DV360.
 *
 * Por que Cloudinary: a Xandr API não roda transcoding síncrono no upload como
 * a UI manual faz. Um MP4 H.264 high-bitrate (30 Mbps) cria VAST com 1 MediaFile
 * inservível pra serving em RTB — players de publisher não conseguem tocar a
 * tempo. Caso real: creative levou 4 dias pro pipeline interno da Xandr gerar
 * versões reduzidas, e durante esse tempo a line item não entregou nada.
 *
 * Solução: transcoda antes via Cloudinary → 1280x720 H.264 baseline @ 2.5 Mbps
 * (specs hosted video da Xandr). Vídeo já chega elegível pra serving imediato.
 *
 * Por que não ffmpeg.wasm dentro do edge function (validado empiricamente):
 *   - @ffmpeg/ffmpeg@0.12+ depende de Web Worker (não disponível em Deno edge)
 *   - Deno.Command é bloqueado: "Spawning subprocesses is not allowed on
 *     Supabase Edge Runtime"
 *   - Worker stub faz ffmpeg.wasm pendurar esperando handshake
 *
 * Setup necessário (secrets no Supabase Edge Functions):
 *   - CLOUDINARY_CLOUD_NAME
 *   - CLOUDINARY_API_KEY
 *   - CLOUDINARY_API_SECRET
 *
 * Free tier (25GB credits/mês) cobre o volume típico da operação.
 */

const CLOUDINARY_API = 'https://api.cloudinary.com/v1_1';

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface CloudinaryTranscodeResult {
  blob: Blob;
  publicId: string;
  bytes: number;
  bitrateKbps: number;
  durationSeconds: number;
}

/**
 * Lê secrets do ambiente. Retorna null se algum estiver faltando — caller decide
 * se segue com original ou falha. Não joga erro pra deixar o caller controlar
 * UX (warning vs hard fail).
 */
export function getCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME');
  const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
  const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

/**
 * SHA-1 hex digest. Usado pro signing do Cloudinary upload.
 * Cloudinary exige SHA-1 (não SHA-256) — legacy do API original.
 */
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Cria assinatura HMAC pra upload signed do Cloudinary.
 * Spec: https://cloudinary.com/documentation/signatures
 *
 *   1. Excluir `file`, `signature`, `api_key`, `resource_type`
 *   2. Ordenar chaves alfabeticamente
 *   3. Construir querystring `key1=value1&key2=value2`
 *   4. Concatenar `+API_SECRET`
 *   5. SHA-1 hex
 */
async function signParams(
  params: Record<string, string>,
  apiSecret: string,
): Promise<string> {
  const excluded = new Set(['file', 'signature', 'api_key', 'resource_type']);
  const toSign = Object.keys(params)
    .filter((k) => !excluded.has(k) && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return sha1Hex(toSign + apiSecret);
}

/**
 * Upload + transcode num único request. Cloudinary processa o vídeo de forma
 * eager (síncrona) e retorna o resultado direto na response — sem polling.
 *
 * Usa eager_async=false pra esperar o resultado. Vídeos curtos (até 60s) ficam
 * prontos em ~5-15s. Vídeos longos podem estourar o timeout do edge function
 * (150s padrão) — neste caso, refatorar pra eager_async=true + polling.
 *
 * Transformações aplicadas:
 *   - q_auto:eco          → quality ótima com bias pra tamanho menor
 *   - vc_h264:baseline    → codec H.264 Baseline (compat com qualquer player)
 *   - br_2500k            → bitrate target 2500 kbps
 *   - w_1280,h_720        → largura/altura máxima
 *   - c_limit             → reduz se exceder, nunca aumenta
 *   - f_mp4 + ac_aac      → container MP4, audio AAC
 *   - faststart é aplicado automaticamente pelo Cloudinary em outputs MP4
 *
 * Cleanup: faz destroy do asset depois de baixar pra não acumular lixo no
 * plano free (limite 25GB storage). Falha silenciosa — operação principal
 * já completou.
 */
export async function cloudinaryTranscodeVideo(
  input: Blob,
  fileName: string,
  config: CloudinaryConfig,
): Promise<CloudinaryTranscodeResult> {
  const t0 = Date.now();
  const eagerTransform = 'q_auto:eco,vc_h264:baseline,br_2500k,w_1280,h_720,c_limit,f_mp4,ac_aac';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `adbolt-transcode/${timestamp}_${Math.random().toString(36).substring(2, 10)}`;

  const signedParams: Record<string, string> = {
    timestamp,
    public_id: publicId,
    eager: eagerTransform,
    eager_async: 'false',
    overwrite: 'true',
  };
  const signature = await signParams(signedParams, config.apiSecret);

  const fd = new FormData();
  fd.append('file', input, fileName);
  fd.append('api_key', config.apiKey);
  fd.append('timestamp', signedParams.timestamp);
  fd.append('public_id', signedParams.public_id);
  fd.append('eager', signedParams.eager);
  fd.append('eager_async', signedParams.eager_async);
  fd.append('overwrite', signedParams.overwrite);
  fd.append('signature', signature);

  console.log(`[cloudinary] Uploading ${fileName} (${input.size} bytes)...`);
  const uploadRes = await fetch(`${CLOUDINARY_API}/${config.cloudName}/video/upload`, {
    method: 'POST',
    body: fd,
  });
  const uploadData = await uploadRes.json();

  if (!uploadRes.ok) {
    throw new Error(`Cloudinary upload failed (${uploadRes.status}): ${JSON.stringify(uploadData).substring(0, 500)}`);
  }

  const eagerResult = uploadData.eager?.[0];
  if (!eagerResult?.secure_url) {
    throw new Error(`Cloudinary não retornou eager output: ${JSON.stringify(uploadData).substring(0, 500)}`);
  }

  console.log(`[cloudinary] Transcoded in ${Date.now() - t0}ms, fetching from CDN...`);
  const transcodedRes = await fetch(eagerResult.secure_url);
  if (!transcodedRes.ok) {
    throw new Error(`Cloudinary CDN fetch failed: ${transcodedRes.status}`);
  }
  const transcodedBlob = await transcodedRes.blob();

  // Cleanup fire-and-forget — não bloqueia o retorno
  void deleteCloudinaryAsset(uploadData.public_id, config);

  // Cloudinary retorna duration em segundos (float) e às vezes um bit_rate em
  // bps no eager output. Quando não vem, derivamos do blob baixado — sempre
  // existe e é o tamanho real que vai pra Xandr.
  const durationSeconds = typeof uploadData.duration === 'number' ? uploadData.duration : 0;
  const bitrateKbps = eagerResult.bit_rate
    ? Math.round(eagerResult.bit_rate / 1000)
    : (durationSeconds > 0 ? Math.round((transcodedBlob.size * 8) / durationSeconds / 1000) : 0);

  return {
    blob: transcodedBlob,
    publicId: uploadData.public_id,
    bytes: transcodedBlob.size,
    bitrateKbps,
    durationSeconds,
  };
}

/**
 * Deleta um asset do Cloudinary pra não acumular lixo no plano free.
 * Falha silenciosa — operação principal já completou.
 */
async function deleteCloudinaryAsset(
  publicId: string,
  config: CloudinaryConfig,
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params: Record<string, string> = { public_id: publicId, timestamp };
  const signature = await signParams(params, config.apiSecret);

  const fd = new FormData();
  fd.append('public_id', publicId);
  fd.append('timestamp', timestamp);
  fd.append('api_key', config.apiKey);
  fd.append('signature', signature);

  try {
    const res = await fetch(`${CLOUDINARY_API}/${config.cloudName}/video/destroy`, {
      method: 'POST',
      body: fd,
    });
    const data = await res.json();
    console.log(`[cloudinary] Cleanup ${publicId}: ${data.result || 'unknown'}`);
  } catch (err) {
    console.warn(`[cloudinary] Cleanup failed for ${publicId}: ${(err as Error).message}`);
  }
}
