/**
 * Asset file processing utilities.
 * All functions are client-side only (Canvas, Image, Video APIs).
 * Ported from legacy lines 2267-2382.
 */

const DISPLAY_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm']);

export type AssetFileType = 'display' | 'video' | null;

export function getAssetType(file: File): AssetFileType {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (DISPLAY_EXTS.has(ext)) return 'display';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

export function readFileDimensions(
  file: File,
  type: 'display' | 'video',
): Promise<{ w: number; h: number; duration?: number }> {
  return new Promise((resolve) => {
    if (type === 'display') {
      const img = new Image();
      img.onload = () => {
        resolve({ w: img.naturalWidth, h: img.naturalHeight });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = URL.createObjectURL(file);
    } else {
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      vid.onloadedmetadata = () => {
        resolve({ w: vid.videoWidth, h: vid.videoHeight, duration: Math.round(vid.duration) });
        URL.revokeObjectURL(vid.src);
      };
      vid.onerror = () => resolve({ w: 0, h: 0, duration: 0 });
      vid.src = URL.createObjectURL(file);
    }
  });
}

export function generateThumb(file: File, type: 'display' | 'video' | 'html5'): Promise<string> {
  return new Promise((resolve) => {
    if (type === 'html5') {
      // HTML5 ZIPs get a synthetic thumbnail (created in handleHTML5Zip)
      resolve('');
      return;
    }
    if (type === 'display') {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d')!;
        const s = Math.min(96 / img.naturalWidth, 72 / img.naturalHeight, 1);
        c.width = img.naturalWidth * s;
        c.height = img.naturalHeight * s;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve('');
      img.src = URL.createObjectURL(file);
    } else {
      const vid = document.createElement('video');
      vid.preload = 'auto';
      vid.muted = true;
      vid.onloadeddata = () => { vid.currentTime = 1; };
      vid.onseeked = () => {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d')!;
        const s = Math.min(96 / vid.videoWidth, 72 / vid.videoHeight, 1);
        c.width = vid.videoWidth * s;
        c.height = vid.videoHeight * s;
        ctx.drawImage(vid, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
        URL.revokeObjectURL(vid.src);
      };
      vid.onerror = () => resolve('');
      vid.src = URL.createObjectURL(file);
    }
  });
}

export function compressImage(
  file: File,
  maxBytes: number,
): Promise<{ file: File; compressed: boolean; originalSize?: number; newSize?: number }> {
  if (file.size <= maxBytes) return Promise.resolve({ file, compressed: false });

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d')!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      let q = 0.85;
      const tryCompress = () => {
        c.toBlob(
          (blob) => {
            if (!blob) { resolve({ file, compressed: false }); return; }
            if (blob.size <= maxBytes || q < 0.1) {
              const newFile = new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
              resolve({ file: newFile, compressed: true, originalSize: file.size, newSize: blob.size });
            } else {
              q -= 0.1;
              tryCompress();
            }
          },
          'image/jpeg',
          q,
        );
      };
      tryCompress();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

export function resizeAssetImage(
  originalFile: File,
  newW: number,
  newH: number,
): Promise<{ file: File; thumb: string } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = newW;
      c.height = newH;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, newW, newH);
      c.toBlob(
        (blob) => {
          if (!blob) { resolve(null); return; }
          const ext = originalFile.name.split('.').pop()?.toLowerCase() || 'jpg';
          const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
          const newFile = new File([blob], originalFile.name, { type: mimeMap[ext] || 'image/jpeg' });

          // Generate new thumb
          const tc = document.createElement('canvas');
          const tctx = tc.getContext('2d')!;
          const s = Math.min(96 / newW, 72 / newH, 1);
          tc.width = newW * s;
          tc.height = newH * s;
          tctx.drawImage(img, 0, 0, tc.width, tc.height);
          const thumb = tc.toDataURL('image/jpeg', 0.7);

          URL.revokeObjectURL(img.src);
          resolve({ file: newFile, thumb });
        },
        originalFile.type === 'image/png' ? 'image/png' : 'image/jpeg',
        0.9,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null); };
    img.src = URL.createObjectURL(originalFile);
  });
}

/**
 * IAB size validation and suggestion.
 * Ported from legacy lines 2273-2286.
 */
import { IAB_SIZES } from '@/types';

export function isIABSize(dim: string): boolean {
  return IAB_SIZES.has(dim);
}

export function getSizeSuggestion(w: number, h: number): string {
  let best = '';
  let bestScore = Infinity;
  IAB_SIZES.forEach((s) => {
    const [sw, sh] = s.split('x').map(Number);
    const arDiff = Math.abs(w / h - sw / sh);
    const areaDiff = Math.abs(w * h - sw * sh) / (w * h);
    const score = arDiff * 2 + areaDiff;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  });
  return best;
}
