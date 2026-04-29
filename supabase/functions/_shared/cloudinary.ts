/**
 * Cloudinary integration — transcode de vídeos pra Xandr/DV360.
 * Setup: secrets CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *
 * IMPORTANTE: aceita URL como input (não Blob). Edge function Supabase tem
 * limite de ~256MB RAM por isolate. Materializar blob de 100MB+ na memória
 * pra fazer multipart upload causa crash 546 (Worker OOM). Em vez disso,
 * passamos uma signed URL do storage pra Cloudinary baixar direto — o edge
 * function nunca toca o arquivo grande, só passa um link.
 */

const CLOUDINARY_API = 'https://api.cloudinary.com/v1_1';

export interface CloudinaryConfig { cloudName: string; apiKey: string; apiSecret: string; }
export interface CloudinaryTranscodeResult { blob: Blob; publicId: string; bytes: number; bitrateKbps: number; durationSeconds: number; }

export function getCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME');
  const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
  const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signParams(params: Record<string, string>, apiSecret: string): Promise<string> {
  const excluded = new Set(['file', 'signature', 'api_key', 'resource_type']);
  const toSign = Object.keys(params).filter((k) => !excluded.has(k) && params[k] !== '').sort().map((k) => `${k}=${params[k]}`).join('&');
  return sha1Hex(toSign + apiSecret);
}

/**
 * Transcoda um vídeo via Cloudinary passando uma URL pública (signed URL do
 * storage, por exemplo). Cloudinary baixa direto da URL, processa e devolve
 * o transcoded inline na response do upload.
 *
 * Por que URL e não Blob: 256MB RAM limit do edge function Supabase. Pra
 * vídeos > 80MB, materializar como FormData crash o isolate (status 546).
 */
export async function cloudinaryTranscodeVideoFromUrl(sourceUrl: string, fileName: string, config: CloudinaryConfig): Promise<CloudinaryTranscodeResult> {
  const t0 = Date.now();
  const eagerTransform = 'q_auto:eco,vc_h264:baseline,br_2500k,w_1280,h_720,c_limit,f_mp4,ac_aac';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `adbolt-transcode/${timestamp}_${Math.random().toString(36).substring(2, 10)}`;

  const signedParams: Record<string, string> = {
    timestamp, public_id: publicId,
    eager: eagerTransform, eager_async: 'false', overwrite: 'true',
  };
  const signature = await signParams(signedParams, config.apiSecret);

  // POST application/x-www-form-urlencoded com `file` sendo a URL.
  // Cloudinary detecta que é URL e baixa do servidor remoto.
  // Body é só uma string com os params — não materializa o vídeo.
  const formBody = new URLSearchParams({
    file: sourceUrl,
    api_key: config.apiKey,
    timestamp: signedParams.timestamp,
    public_id: signedParams.public_id,
    eager: signedParams.eager,
    eager_async: signedParams.eager_async,
    overwrite: signedParams.overwrite,
    signature,
  });

  console.log(`[cloudinary] Fetching from URL: ${sourceUrl.substring(0, 80)}...`);
  const uploadRes = await fetch(`${CLOUDINARY_API}/${config.cloudName}/video/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(`Cloudinary upload failed (${uploadRes.status}): ${JSON.stringify(uploadData).substring(0, 500)}`);

  const eagerResult = uploadData.eager?.[0];
  if (!eagerResult?.secure_url) throw new Error(`Cloudinary não retornou eager output: ${JSON.stringify(uploadData).substring(0, 500)}`);

  console.log(`[cloudinary] Transcoded in ${Date.now() - t0}ms (${uploadData.bytes} → ${eagerResult.bytes} bytes), fetching from CDN...`);
  const transcodedRes = await fetch(eagerResult.secure_url);
  if (!transcodedRes.ok) throw new Error(`Cloudinary CDN fetch failed: ${transcodedRes.status}`);
  const transcodedBlob = await transcodedRes.blob();

  void deleteCloudinaryAsset(uploadData.public_id, config);

  const durationSeconds = typeof uploadData.duration === 'number' ? uploadData.duration : 0;
  const bitrateKbps = eagerResult.bit_rate
    ? Math.round(eagerResult.bit_rate / 1000)
    : (durationSeconds > 0 ? Math.round((transcodedBlob.size * 8) / durationSeconds / 1000) : 0);

  return { blob: transcodedBlob, publicId: uploadData.public_id, bytes: transcodedBlob.size, bitrateKbps, durationSeconds };
}

/**
 * @deprecated Use cloudinaryTranscodeVideoFromUrl. Materializar Blob >80MB
 * em FormData estoura RAM do edge function isolate (status 546).
 */
export async function cloudinaryTranscodeVideo(input: Blob, fileName: string, config: CloudinaryConfig): Promise<CloudinaryTranscodeResult> {
  const t0 = Date.now();
  const eagerTransform = 'q_auto:eco,vc_h264:baseline,br_2500k,w_1280,h_720,c_limit,f_mp4,ac_aac';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `adbolt-transcode/${timestamp}_${Math.random().toString(36).substring(2, 10)}`;
  const signedParams: Record<string, string> = { timestamp, public_id: publicId, eager: eagerTransform, eager_async: 'false', overwrite: 'true' };
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
  const uploadRes = await fetch(`${CLOUDINARY_API}/${config.cloudName}/video/upload`, { method: 'POST', body: fd });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(`Cloudinary upload failed (${uploadRes.status}): ${JSON.stringify(uploadData).substring(0, 500)}`);
  const eagerResult = uploadData.eager?.[0];
  if (!eagerResult?.secure_url) throw new Error(`Cloudinary não retornou eager output: ${JSON.stringify(uploadData).substring(0, 500)}`);
  console.log(`[cloudinary] Transcoded in ${Date.now() - t0}ms, fetching from CDN...`);
  const transcodedRes = await fetch(eagerResult.secure_url);
  if (!transcodedRes.ok) throw new Error(`Cloudinary CDN fetch failed: ${transcodedRes.status}`);
  const transcodedBlob = await transcodedRes.blob();
  void deleteCloudinaryAsset(uploadData.public_id, config);
  const durationSeconds = typeof uploadData.duration === 'number' ? uploadData.duration : 0;
  const bitrateKbps = eagerResult.bit_rate ? Math.round(eagerResult.bit_rate / 1000) : (durationSeconds > 0 ? Math.round((transcodedBlob.size * 8) / durationSeconds / 1000) : 0);
  return { blob: transcodedBlob, publicId: uploadData.public_id, bytes: transcodedBlob.size, bitrateKbps, durationSeconds };
}

async function deleteCloudinaryAsset(publicId: string, config: CloudinaryConfig): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params: Record<string, string> = { public_id: publicId, timestamp };
  const signature = await signParams(params, config.apiSecret);
  const formBody = new URLSearchParams({
    public_id: publicId,
    timestamp,
    api_key: config.apiKey,
    signature,
  });
  try {
    const res = await fetch(`${CLOUDINARY_API}/${config.cloudName}/video/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });
    const data = await res.json();
    console.log(`[cloudinary] Cleanup ${publicId}: ${data.result || 'unknown'}`);
  } catch (err) {
    console.warn(`[cloudinary] Cleanup failed for ${publicId}: ${(err as Error).message}`);
  }
}
