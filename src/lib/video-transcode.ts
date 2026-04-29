/**
 * Video transcoding via ffmpeg.wasm (multi-thread).
 *
 * Lazy-loads the WASM core (~30MB) only when actually called — most uploads
 * don't need it (display, HTML5, well-formed videos). The core is cached at
 * module level so repeated transcodes in the same session don't re-fetch.
 *
 * Why client-side: avoids round-trips to Supabase storage for files that will
 * be discarded anyway, and gives the user immediate feedback. Trade-off is
 * CPU on the user's machine — for typical creatives (≤30s, ≤100MB) this runs
 * in single-digit seconds on multi-thread.
 *
 * COOP/COEP requirements: handled in `vercel.json` and `vite.config.ts`.
 * Without those headers, SharedArrayBuffer is unavailable and the multi-thread
 * core fails to load.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { VIDEO_TRANSCODE_TARGET } from '@/types';

// CDN base for ffmpeg-core multi-thread build. Pinning version to match the
// wrapper version (0.12.x) so a future @ffmpeg/ffmpeg upgrade doesn't load a
// mismatched core that crashes.
const FFMPEG_CORE_BASE = 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/esm';

// Cached singleton — loading the WASM is expensive (~30MB download + compile),
// no reason to do it twice.
let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

/**
 * Loads ffmpeg.wasm core. Idempotent — concurrent calls share the same load.
 */
async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onLog) {
      ffmpeg.on('log', ({ message }) => onLog(message));
    }
    await ffmpeg.load({
      coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return loadPromise;
}

export interface TranscodeProgress {
  phase: 'loading-core' | 'reading' | 'transcoding' | 'finalizing';
  /** 0..1 — só `transcoding` tem progresso real, demais fases são marcos */
  progress: number;
  message: string;
}

export interface TranscodeResult {
  file: File;
  durationMs: number;
  inputSize: number;
  outputSize: number;
}

/**
 * Transcoda um vídeo pro target padrão da AdBolt (1280x720 max, H.264 baseline,
 * 2.5 Mbps, AAC 128 kbps, faststart). Mantém o aspect ratio original — só
 * reduz se exceder 1280x720, nunca aumenta.
 *
 * O ffmpeg.wasm escreve o output no FS virtual, lemos como Uint8Array e
 * embrulhamos em File com mime type correto.
 */
export async function transcodeVideo(
  input: File,
  onProgress?: (p: TranscodeProgress) => void,
): Promise<TranscodeResult> {
  const t0 = performance.now();

  onProgress?.({ phase: 'loading-core', progress: 0, message: 'Carregando ffmpeg…' });
  const ffmpeg = await getFFmpeg();

  // Progresso real do ffmpeg vem como float 0..1 no evento 'progress'
  const progressHandler = ({ progress }: { progress: number }) => {
    // ffmpeg às vezes reporta progress >1 ou <0 — clamp pra evitar UI quebrada
    const clamped = Math.max(0, Math.min(1, progress));
    onProgress?.({ phase: 'transcoding', progress: clamped, message: `Transcodando ${Math.round(clamped * 100)}%` });
  };
  ffmpeg.on('progress', progressHandler);

  try {
    const inputName = 'in.' + (input.name.split('.').pop() || 'mp4').toLowerCase();
    const outputName = 'out.mp4';

    onProgress?.({ phase: 'reading', progress: 0, message: 'Preparando arquivo…' });
    await ffmpeg.writeFile(inputName, await fetchFile(input));

    const { maxWidth, maxHeight, videoBitrateKbps, audioBitrateKbps, profile, level } = VIDEO_TRANSCODE_TARGET;

    // Filtro de scale com aspect-ratio preservado:
    //   - Reduz se exceder maxWidth ou maxHeight
    //   - `force_original_aspect_ratio=decrease` mantém a menor das duas dimensões fittando
    //   - `-2` na altura força ela a ser par (libx264 exige) sem distorcer
    const scaleFilter = `scale='min(${maxWidth},iw)':'-2':force_original_aspect_ratio=decrease,scale='-2':'min(${maxHeight},ih)'`;

    const args = [
      '-i', inputName,
      '-c:v', 'libx264',
      '-profile:v', profile,
      '-level', level,
      '-preset', 'fast', // balance speed/size — `fast` é ~3x mais rápido que `medium` com ~5% loss
      '-b:v', `${videoBitrateKbps}k`,
      '-maxrate', `${videoBitrateKbps}k`,
      '-bufsize', `${videoBitrateKbps * 2}k`,
      '-vf', scaleFilter,
      '-pix_fmt', 'yuv420p', // requirement pra compat com player web/mobile
      '-c:a', 'aac',
      '-b:a', `${audioBitrateKbps}k`,
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart', // moov atom no início = streaming-friendly
      '-y',
      outputName,
    ];

    onProgress?.({ phase: 'transcoding', progress: 0, message: 'Transcodando 0%' });
    await ffmpeg.exec(args);

    onProgress?.({ phase: 'finalizing', progress: 1, message: 'Finalizando…' });
    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);

    // Cleanup do FS virtual — não acumular lixo entre transcodes
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});

    const outputName2 = input.name.replace(/\.[^.]+$/, '') + '_optimized.mp4';
    // Use Blob constructor to avoid TS lib mismatch on File constructor signature
    const blob = new Blob([bytes as BlobPart], { type: 'video/mp4' });
    const file = new File([blob], outputName2, { type: 'video/mp4', lastModified: Date.now() });

    return {
      file,
      durationMs: Math.round(performance.now() - t0),
      inputSize: input.size,
      outputSize: file.size,
    };
  } finally {
    ffmpeg.off('progress', progressHandler);
  }
}

/**
 * Pré-carrega o core sem transcodar nada. Útil pra "warm up" enquanto o usuário
 * ainda está olhando a UI antes de clicar Otimizar.
 */
export function preloadFFmpeg(): void {
  void getFFmpeg();
}
