/**
 * Tests for video analysis. Bate as três responsabilidades:
 *   1. Bitrate estimation (math)
 *   2. Codec detection via ftyp box (binary parsing)
 *   3. Status classification contra os thresholds
 *
 * Mocka HTMLVideoElement pra fingir que metadata foi lida com sucesso, já que
 * jsdom não decoda video real. Pra MP4 ftyp, construímos os bytes na mão.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeVideo } from '@/lib/video-analysis';
import { VIDEO_BITRATE_OK_KBPS, VIDEO_BITRATE_HARD_KBPS } from '@/types';

// ── Helpers ──

/** Constrói um File com header MP4 ftyp contendo o brand especificado. */
function makeMp4File(brand: string, totalSize: number, name = 'test.mp4'): File {
  const enc = new TextEncoder();
  const ftyp = new Uint8Array(32);
  // Box size = 32
  ftyp[0] = 0; ftyp[1] = 0; ftyp[2] = 0; ftyp[3] = 32;
  // Box type = 'ftyp'
  ftyp.set(enc.encode('ftyp'), 4);
  // Major brand = brand
  ftyp.set(enc.encode(brand.padEnd(4, ' ').slice(0, 4)), 8);
  // Minor version (any)
  ftyp[12] = 0; ftyp[13] = 0; ftyp[14] = 0; ftyp[15] = 0;
  // Compatible brands at byte 16 — repete brand pra simular MP4 real
  ftyp.set(enc.encode(brand.padEnd(4, ' ').slice(0, 4)), 16);

  // Pad até totalSize com zeros (representa o resto do arquivo)
  const padded = new Uint8Array(totalSize);
  padded.set(ftyp, 0);

  return new File([padded], name, { type: 'video/mp4' });
}

/** Cria um elemento mock que dispara onloadedmetadata com os valores fixos. */
interface MockVideoEl {
  preload: string;
  muted: boolean;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  onloadedmetadata: null | (() => void);
  onerror: null | (() => void);
  _src: string;
  src: string;
}
function mockVideoMeta(width: number, height: number, duration: number) {
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'video') return realCreate(tag);
    const el: MockVideoEl = {
      preload: '',
      muted: false,
      videoWidth: width,
      videoHeight: height,
      duration,
      onloadedmetadata: null,
      onerror: null,
      _src: '',
      get src() { return this._src; },
      set src(v: string) {
        this._src = v;
        // Simula o evento async — duration=0 dispara onerror, > 0 dispara onloadedmetadata
        queueMicrotask(() => {
          if (duration > 0) this.onloadedmetadata?.();
          else this.onerror?.();
        });
      },
    };
    return el as unknown as HTMLVideoElement;
  });
}

// URL.createObjectURL / revokeObjectURL não existem em jsdom por padrão
beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

// ── Tests ──

describe('analyzeVideo', () => {
  it('classifies a low-bitrate H.264 video as ok', async () => {
    mockVideoMeta(1280, 720, 15);
    // 15s * 2000 kbps = 30000 kbits = 3,750,000 bytes
    const file = makeMp4File('avc1', 3_750_000);
    const result = await analyzeVideo(file);

    expect(result.codec).toBe('avc1');
    expect(result.duration).toBe(15);
    expect(result.bitrateKbps).toBe(2000);
    expect(result.status).toBe('ok');
    expect(result.warnings).toEqual([]);
  });

  it('flags a high-bitrate H.264 video as fail', async () => {
    mockVideoMeta(1920, 1080, 14);
    // Reproduz o caso da Heineken: 14s, ~30 Mbps
    const fileSize = Math.round((30000 * 1000 * 14) / 8);
    const file = makeMp4File('avc1', fileSize);
    const result = await analyzeVideo(file);

    expect(result.codec).toBe('avc1');
    expect(result.bitrateKbps).toBeGreaterThan(VIDEO_BITRATE_HARD_KBPS);
    expect(result.status).toBe('fail');
    expect(result.warnings[0]).toMatch(/bitrate/i);
  });

  it('warns on medium bitrate (between OK and HARD thresholds)', async () => {
    mockVideoMeta(1280, 720, 10);
    // 6000 kbps — entre 4000 (OK) e 8000 (HARD)
    const fileSize = Math.round((6000 * 1000 * 10) / 8);
    const file = makeMp4File('avc1', fileSize);
    const result = await analyzeVideo(file);

    expect(result.bitrateKbps).toBeGreaterThan(VIDEO_BITRATE_OK_KBPS);
    expect(result.bitrateKbps).toBeLessThanOrEqual(VIDEO_BITRATE_HARD_KBPS);
    expect(result.status).toBe('warn');
  });

  it('flags HEVC (hev1) as fail regardless of bitrate', async () => {
    mockVideoMeta(1280, 720, 20);
    // Bitrate baixo, mas codec não suportado pela maioria dos players
    const file = makeMp4File('hev1', 1_000_000);
    const result = await analyzeVideo(file);

    expect(result.codec).toBe('hev1');
    expect(result.status).toBe('fail');
    expect(result.warnings[0]).toMatch(/codec/i);
  });

  it('flags hvc1 (HEVC alternate brand) as fail', async () => {
    mockVideoMeta(1280, 720, 20);
    const file = makeMp4File('hvc1', 1_000_000);
    const result = await analyzeVideo(file);

    expect(result.codec).toBe('hvc1');
    expect(result.status).toBe('fail');
  });

  it('flags AV1 (av01) as fail', async () => {
    mockVideoMeta(1280, 720, 20);
    const file = makeMp4File('av01', 1_000_000);
    const result = await analyzeVideo(file);

    expect(result.codec).toBe('av01');
    expect(result.status).toBe('fail');
  });

  it('fails on duration=0 (corrupted metadata)', async () => {
    mockVideoMeta(1280, 720, 0);
    const file = makeMp4File('avc1', 1_000_000);
    const result = await analyzeVideo(file);

    expect(result.duration).toBe(0);
    expect(result.bitrateKbps).toBe(0);
    expect(result.status).toBe('fail');
    expect(result.warnings[0]).toMatch(/duration/i);
  });

  it('returns empty codec for non-MP4 files (gracefully)', async () => {
    mockVideoMeta(1280, 720, 10);
    // File sem ftyp box válido — apenas zeros
    const blob = new Blob([new Uint8Array(1_000_000)], { type: 'video/mp4' });
    const file = new File([blob], 'broken.mp4', { type: 'video/mp4' });
    const result = await analyzeVideo(file);

    expect(result.codec).toBe('');
    // Sem codec detectado, depende só do bitrate (800 kbps = ok)
    expect(result.status).toBe('ok');
  });
});
