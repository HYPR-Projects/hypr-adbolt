import type { AssetEntry, DspType, Tracker } from '@/types';
import { mergeTrackers } from '@/parsers/tracker';
import { SUPABASE_URL } from '@/services/supabase';

/**
 * Upload a thumbnail (base64 data URL) to the public 'thumbnails' bucket.
 * Returns the full public URL.
 */
export async function uploadThumbnail(
  dataUrl: string,
  token: string,
): Promise<string> {
  if (!dataUrl || !dataUrl.startsWith('data:')) return '';

  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });

  const path = `t/${Date.now()}_${Math.random().toString(36).substr(2, 6)}.${ext}`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/thumbnails/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': mime,
      'x-upsert': 'true',
    },
    body: blob,
  });

  if (!res.ok) {
    console.warn('Thumbnail upload failed:', await res.text());
    return '';
  }

  return `${SUPABASE_URL}/storage/v1/object/public/thumbnails/${path}`;
}

/**
 * Upload HTML5 preview content (self-contained HTML with inlined resources)
 * to the public 'thumbnails' bucket. Returns the full public URL.
 * Includes retry with backoff for reliability.
 */
export async function uploadHtml5Preview(
  htmlContent: string,
  token: string,
): Promise<string> {
  if (!htmlContent) return '';

  const blob = new Blob([htmlContent], { type: 'text/html' });
  const path = `h5/${Date.now()}_${Math.random().toString(36).substr(2, 6)}.html`;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/thumbnails/${path}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'text/html',
          'x-upsert': 'true',
        },
        body: blob,
      });

      if (res.ok) {
        return `${SUPABASE_URL}/storage/v1/object/public/thumbnails/${path}`;
      }

      const errText = await res.text();
      console.warn(`HTML5 preview upload attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${res.status}):`, errText);
    } catch (err) {
      console.warn(`HTML5 preview upload attempt ${attempt + 1}/${MAX_RETRIES + 1} network error:`, err);
    }
  }

  console.error('HTML5 preview upload failed after all retries');
  return '';
}

/**
 * Upload a file to Supabase Storage (asset-uploads bucket).
 * Returns the storage path.
 * Ported from legacy: async function uploadToStorage(file, token) — lines 1364-1374
 */
export async function uploadToStorage(file: File, token: string): Promise<string> {
  const ext = file.name.split('.').pop() || 'bin';
  const path = `uploads/${Date.now()}_${Math.random().toString(36).substr(2, 6)}.${ext}`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/asset-uploads/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': file.type,
      'x-upsert': 'true',
    },
    body: file,
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error('Storage upload failed: ' + t);
  }

  return path;
}

/**
 * Upload an asset to storage (with memoization on _storagePath).
 * Ported from legacy: async function uploadAssetToStorage(asset, token, progressCb)
 */
export async function uploadAssetToStorage(
  asset: AssetEntry,
  token: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  if (asset._storagePath) return asset._storagePath;

  const file = asset.compressedFile || asset.originalFile;
  if (onProgress) onProgress('Enviando ' + asset.name + ' pro storage...');

  const storagePath = await uploadToStorage(file, token);
  asset._storagePath = storagePath;
  asset._uploadedFile = file;

  return storagePath;
}

/**
 * Build the creative payload for a DSP from an asset entry.
 * Ported from legacy: function buildCreativePayload(asset, dsp)
 */
export function buildCreativePayload(
  asset: AssetEntry,
  dsp: DspType,
): {
  name: string;
  type: string;
  dimensions: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string | undefined;
  landingPage: string;
  trackers: Tracker[];
  duration: number;
} {
  const file = asset._uploadedFile || asset.compressedFile || asset.originalFile;

  return {
    name: asset.name,
    type: asset.type,
    dimensions: asset.dimensions,
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    storagePath: asset._storagePath,
    landingPage: asset.landingPage,
    trackers: mergeTrackers(asset.trackers || [], dsp),
    duration: asset.duration || 0,
  };
}

