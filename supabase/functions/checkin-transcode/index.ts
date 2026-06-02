import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Web-optimized MP4 for the check-in preview, using the SAME Cloudinary transcode
// the DSP activation uses (mirror of _shared/cloudinary.ts: 720p, ~2500kbps,
// H.264 baseline, faststart). The DSP flow deletes its Cloudinary output after
// sending to the DSP, so nothing reusable is left; here we keep the result in the
// public `checkins` bucket and cache it. A 180MB raw upload becomes a ~15-25MB CDN
// file the share preview streams. Transcoded once per source; later calls hit the
// cache. On any failure the caller falls back to the raw asset (no regression).
// Self-contained on purpose: single-file deploy, no shared-dep coupling.

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const OUT_BUCKET = 'checkins';
const CLOUDINARY_API = 'https://api.cloudinary.com/v1_1';
// Mirror of _shared/cloudinary.ts — keep in sync if the DSP transform changes.
const EAGER = 'q_auto:eco,vc_h264:baseline,br_2500k,w_1280,h_720,c_limit,f_mp4,ac_aac';

async function sha1Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signParams(params: Record<string, string>, apiSecret: string): Promise<string> {
  const excluded = new Set(['file', 'signature', 'api_key', 'resource_type']);
  const toSign = Object.keys(params)
    .filter((k) => !excluded.has(k) && params[k] !== '')
    .sort().map((k) => `${k}=${params[k]}`).join('&');
  return sha1Hex(toSign + apiSecret);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const storagePath = String(body.storagePath || '').trim();
    if (!storagePath) {
      return new Response(JSON.stringify({ error: 'missing_storage_path' }), { status: 400, headers: CORS });
    }

    const cloudName = Deno.env.get('CLOUDINARY_CLOUD_NAME');
    const apiKey = Deno.env.get('CLOUDINARY_API_KEY');
    const apiSecret = Deno.env.get('CLOUDINARY_API_SECRET');
    if (!cloudName || !apiKey || !apiSecret) {
      return new Response(JSON.stringify({ error: 'cloudinary_not_configured' }), { status: 503, headers: CORS });
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const outPath = `transcoded/${await sha1Hex(storagePath)}.mp4`;
    const publicUrl = sb.storage.from(OUT_BUCKET).getPublicUrl(outPath).data.publicUrl;

    // Cache hit?
    try {
      const head = await fetch(publicUrl, { method: 'HEAD' });
      if (head.ok && Number(head.headers.get('content-length') || 0) > 0) {
        return new Response(JSON.stringify({ url: publicUrl, cached: true }), { status: 200, headers: CORS });
      }
    } catch (_e) { /* miss → transcode */ }

    // Signed URL of the raw asset — Cloudinary pulls it directly (no RAM blowup).
    const { data: signed, error: signErr } = await sb.storage.from('asset-uploads').createSignedUrl(storagePath, 1800);
    if (signErr || !signed?.signedUrl) {
      return new Response(JSON.stringify({ error: 'sign_failed', message: String(signErr?.message || 'no url') }), { status: 500, headers: CORS });
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const cldPublicId = `adbolt-checkin/${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
    const signedParams: Record<string, string> = {
      timestamp, public_id: cldPublicId, eager: EAGER, eager_async: 'false', overwrite: 'true',
    };
    const signature = await signParams(signedParams, apiSecret);
    const form = new URLSearchParams({
      file: signed.signedUrl, api_key: apiKey, timestamp, public_id: cldPublicId,
      eager: EAGER, eager_async: 'false', overwrite: 'true', signature,
    });

    const upRes = await fetch(`${CLOUDINARY_API}/${cloudName}/video/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    });
    const upData = await upRes.json();
    if (!upRes.ok) {
      return new Response(JSON.stringify({ error: 'cloudinary_failed', message: JSON.stringify(upData).slice(0, 400) }), { status: 502, headers: CORS });
    }
    const eager = upData.eager?.[0];
    if (!eager?.secure_url) {
      return new Response(JSON.stringify({ error: 'no_eager_output' }), { status: 502, headers: CORS });
    }

    // Pull the transcoded MP4 and store it in the public bucket.
    const txRes = await fetch(eager.secure_url);
    if (!txRes.ok) {
      return new Response(JSON.stringify({ error: 'cdn_fetch_failed', status: txRes.status }), { status: 502, headers: CORS });
    }
    const blob = await txRes.blob();

    // Best-effort cleanup of the Cloudinary copy (we keep our own).
    try {
      const dts = Math.floor(Date.now() / 1000).toString();
      const dParams = { public_id: String(upData.public_id), timestamp: dts };
      const dSig = await signParams(dParams, apiSecret);
      await fetch(`${CLOUDINARY_API}/${cloudName}/video/destroy`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ public_id: String(upData.public_id), timestamp: dts, api_key: apiKey, signature: dSig }),
      });
    } catch (_e) { /* non-fatal */ }

    const up = await sb.storage.from(OUT_BUCKET).upload(outPath, blob, {
      contentType: 'video/mp4', upsert: true, cacheControl: '31536000',
    });
    if (up.error) {
      return new Response(JSON.stringify({ error: 'upload_failed', message: String(up.error.message || up.error) }), { status: 500, headers: CORS });
    }

    return new Response(JSON.stringify({ url: publicUrl, cached: false, bytes: blob.size }), { status: 200, headers: CORS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: 'transcode_failed', message }), { status: 500, headers: CORS });
  }
});
