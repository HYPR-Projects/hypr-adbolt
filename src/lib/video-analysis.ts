/**
 * Video analysis utilities — runs entirely client-side, no ffmpeg required.
 *
 * Feeds the AdBolt UI with enough info to decide whether a video needs
 * transcoding before being uploaded to a DSP. The two signals that matter:
 *
 *   1. **Bitrate** — estimated from `fileSize / duration`. The Xandr API does
 *      not transcode on upload (the manual UI does), so a single MediaFile at
 *      30 Mbps in the VAST will stall preview and break delivery. We classify
 *      against thresholds defined in `types/constants.ts`.
 *
 *   2. **Codec** — sniffed from the MP4 `ftyp` box. We only accept H.264
 *      (`avc1`) without transcoding; HEVC/AV1/etc are flagged as fail because
 *      most ad-tech players don't decode them.
 *
 * Browser metadata extraction (`<video>` element) gives us width/height/duration,
 * but doesn't expose codec. The MP4 spec puts the codec brand in the first
 * box of the file (`ftyp`), 32 bytes are enough.
 */

import { VIDEO_BITRATE_OK_KBPS, VIDEO_BITRATE_HARD_KBPS, VIDEO_CODECS_OK } from '@/types';

export interface VideoAnalysis {
  w: number;
  h: number;
  duration: number;       // segundos
  bitrateKbps: number;    // 0 se duration desconhecido
  codec: string;          // 'avc1' | 'hev1' | 'hvc1' | 'av01' | string vazio
  status: 'ok' | 'warn' | 'fail';
  warnings: string[];
}

/**
 * Lê o `ftyp` box do MP4 (primeiros 32 bytes) pra detectar o codec brand.
 * Retorna string vazia se não conseguir identificar (não-MP4, header truncado).
 *
 * Estrutura do `ftyp` box:
 *   - bytes 0-3: tamanho do box (uint32 BE)
 *   - bytes 4-7: tipo do box ('ftyp')
 *   - bytes 8-11: major brand ('isom', 'mp42', etc — não muito útil)
 *   - bytes 12-15: minor version
 *   - bytes 16+: compatible brands (4 bytes cada)
 *
 * O codec real fica no `moov.trak.mdia.minf.stbl.stsd` box, mas extrair isso
 * é caro. Pra nosso uso (filtrar HEVC/AV1), os compatible brands no ftyp dão
 * sinal suficiente porque encoders modernos sempre incluem o codec primário lá.
 *
 * Heurística:
 *   - Se ver 'hev1' ou 'hvc1' nos brands → HEVC/H.265
 *   - Se ver 'av01' → AV1
 *   - Default pra MP4 sem flag clara → assume avc1 (H.264, caso comum)
 *   - Se nem ftyp for encontrado → '' (deixa o ffmpeg.wasm decidir depois)
 */
async function readMp4Codec(file: File): Promise<string> {
  try {
    const head = await file.slice(0, 64).arrayBuffer();
    const view = new Uint8Array(head);
    const td = new TextDecoder('ascii');
    // Verifica se temos um box `ftyp` no offset 4
    const boxType = td.decode(view.slice(4, 8));
    if (boxType !== 'ftyp') return '';
    // Compatible brands a partir do byte 16, em chunks de 4 bytes até o fim do box
    const boxSize = (view[0] << 24) | (view[1] << 16) | (view[2] << 8) | view[3];
    const brandsEnd = Math.min(boxSize, view.length);
    for (let i = 16; i + 4 <= brandsEnd; i += 4) {
      const brand = td.decode(view.slice(i, i + 4)).toLowerCase();
      if (brand === 'hev1' || brand === 'hvc1') return brand;
      if (brand === 'av01') return brand;
      if (brand === 'avc1') return brand;
    }
    // Major brand como fallback
    const major = td.decode(view.slice(8, 12)).toLowerCase();
    if (major === 'hev1' || major === 'hvc1' || major === 'av01' || major === 'avc1') return major;
    // MP4 padrão sem flag explícita — assume H.264 (caso comum)
    return 'avc1';
  } catch {
    return '';
  }
}

/**
 * Lê dimensions + duration via elemento `<video>` do browser.
 * Falha silenciosa retorna duration=0 — o caller trata como erro fatal.
 */
function readVideoMeta(file: File): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((resolve) => {
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.muted = true;
    vid.onloadedmetadata = () => {
      resolve({
        w: vid.videoWidth || 0,
        h: vid.videoHeight || 0,
        // Round pra 2 casas — alguns codecs reportam duration com 6+ casas e isso
        // polui logs/UI. 2 casas dá precisão de 10ms, suficiente pra qualquer DSP.
        duration: Math.round(vid.duration * 100) / 100 || 0,
      });
      URL.revokeObjectURL(vid.src);
    };
    vid.onerror = () => {
      resolve({ w: 0, h: 0, duration: 0 });
      URL.revokeObjectURL(vid.src);
    };
    vid.src = URL.createObjectURL(file);
  });
}

/**
 * Análise completa: dimensões + duration + bitrate estimado + codec + status.
 *
 * Status:
 *   - `ok`   → bitrate ≤ OK threshold E codec compatível E duration > 0
 *   - `warn` → bitrate entre OK e HARD (transcoding recomendado, não obrigatório)
 *   - `fail` → bitrate > HARD OU codec incompatível OU duration=0 (bloqueia ativação Xandr)
 */
export async function analyzeVideo(file: File): Promise<VideoAnalysis> {
  const [meta, codec] = await Promise.all([readVideoMeta(file), readMp4Codec(file)]);
  const warnings: string[] = [];

  // bitrate em kbps. fileSize em bytes * 8 / duration / 1000
  const bitrateKbps = meta.duration > 0
    ? Math.round((file.size * 8) / meta.duration / 1000)
    : 0;

  let status: 'ok' | 'warn' | 'fail' = 'ok';

  // Hard fails primeiro
  if (meta.duration === 0) {
    status = 'fail';
    warnings.push('Não foi possível ler duration do arquivo. Pode estar corrompido ou usar codec não suportado pelo browser.');
  } else if (codec && !VIDEO_CODECS_OK.has(codec)) {
    status = 'fail';
    warnings.push(`Codec ${codec.toUpperCase()} não compatível com serving via VAST. Otimização obrigatória pra converter pra H.264.`);
  } else if (bitrateKbps > VIDEO_BITRATE_HARD_KBPS) {
    status = 'fail';
    warnings.push(`Bitrate ${bitrateKbps.toLocaleString()} kbps muito alto. Trava preview e quebra entrega na DSP — otimização obrigatória.`);
  } else if (bitrateKbps > VIDEO_BITRATE_OK_KBPS) {
    status = 'warn';
    warnings.push(`Bitrate ${bitrateKbps.toLocaleString()} kbps acima do recomendado (${VIDEO_BITRATE_OK_KBPS} kbps). Otimizar reduz risco de erro de player.`);
  }

  return {
    w: meta.w,
    h: meta.h,
    duration: meta.duration,
    bitrateKbps,
    codec,
    status,
    warnings,
  };
}
