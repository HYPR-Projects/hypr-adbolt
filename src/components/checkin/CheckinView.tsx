import { useCallback, useEffect, useRef, useState } from 'react';
import { getFreshToken } from '@/lib/auth-token';
import { useUIStore } from '@/stores/ui';
import styles from './CheckinView.module.css';

interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
  size: string | null;
  source: string;
  confidence: number;
  recommended: boolean;
}

interface CaptureResult {
  url: string;
  screenshotUrl: string;
  pageWidth: number;
  pageHeight: number;
  deviceScaleFactor: number;
  slots: Slot[];
  meta: { consentHandled: boolean; durationMs: number; title: string };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Status = 'idle' | 'capturing' | 'ready' | 'error';

const CAPTURE_MESSAGES = [
  'Carregando a página…',
  'Fechando o aviso de cookies…',
  'Disparando os anúncios lazy-load…',
  'Identificando os espaços de mídia…',
  'Montando o screenshot…',
];

export function CheckinView() {
  const toast = useUIStore((s) => s.toast);

  const [pageUrl, setPageUrl] = useState('');
  const [creativeObjUrl, setCreativeObjUrl] = useState<string | null>(null);
  const [creativeNatural, setCreativeNatural] = useState<{ w: number; h: number } | null>(null);
  const [creativeSize, setCreativeSize] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [progressIdx, setProgressIdx] = useState(0);

  const [result, setResult] = useState<CaptureResult | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [showSlots, setShowSlots] = useState(true);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const [displayW, setDisplayW] = useState(0);

  // Cycle progress messages while capturing.
  useEffect(() => {
    if (status !== 'capturing') return;
    setProgressIdx(0);
    const t = setInterval(() => setProgressIdx((i) => Math.min(i + 1, CAPTURE_MESSAGES.length - 1)), 6000);
    return () => clearInterval(t);
  }, [status]);

  // Track rendered background width to map page-CSS-px → screen px.
  const measure = useCallback(() => {
    if (imgRef.current) setDisplayW(imgRef.current.clientWidth);
  }, []);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const displayScale = result && displayW ? displayW / result.pageWidth : 1;

  // --- Creative upload -------------------------------------------------------
  const onCreativeFile = useCallback(
    (file: File) => {
      if (creativeObjUrl) URL.revokeObjectURL(creativeObjUrl);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        setCreativeNatural({ w: img.naturalWidth, h: img.naturalHeight });
        setCreativeSize(`${img.naturalWidth}x${img.naturalHeight}`);
      };
      img.src = url;
      setCreativeObjUrl(url);
    },
    [creativeObjUrl],
  );

  // --- Capture ---------------------------------------------------------------
  const onCapture = useCallback(async () => {
    let normalized = pageUrl.trim();
    if (!normalized) {
      toast('Informe a URL da página.', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;

    setStatus('capturing');
    setErrorMsg('');
    setResult(null);
    setBox(null);

    try {
      const token = await getFreshToken();
      const res = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: normalized, creativeSize: creativeSize || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);

      const r = data as CaptureResult;
      setResult(r);
      setStatus('ready');

      // Place the creative: snap to the recommended slot, else center it.
      const rec = r.slots.find((s) => s.recommended);
      if (rec) {
        setBox({ x: rec.x, y: rec.y, w: rec.w, h: rec.h });
      } else if (creativeNatural) {
        setBox({
          x: Math.max(0, r.pageWidth / 2 - creativeNatural.w / 2),
          y: 120,
          w: creativeNatural.w,
          h: creativeNatural.h,
        });
      }
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [pageUrl, creativeSize, creativeNatural, toast]);

  // --- Snap to a detected slot ----------------------------------------------
  const snapTo = useCallback(
    (slot: Slot) => {
      if (!creativeNatural) {
        setBox({ x: slot.x, y: slot.y, w: slot.w, h: slot.h });
        return;
      }
      // Fit the creative inside the slot keeping its aspect ratio.
      const ar = creativeNatural.w / creativeNatural.h;
      let w = slot.w;
      let h = w / ar;
      if (h > slot.h) {
        h = slot.h;
        w = h * ar;
      }
      setBox({ x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h });
    },
    [creativeNatural],
  );

  // --- Drag / resize (page-CSS-px, converted from pointer deltas) -----------
  const dragState = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; box: Box } | null>(null);

  const onPointerDownMove = (e: React.PointerEvent) => {
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { mode: 'move', sx: e.clientX, sy: e.clientY, box: { ...box } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerDownResize = (e: React.PointerEvent) => {
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { mode: 'resize', sx: e.clientX, sy: e.clientY, box: { ...box } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds || !displayScale) return;
    const dx = (e.clientX - ds.sx) / displayScale;
    const dy = (e.clientY - ds.sy) / displayScale;
    if (ds.mode === 'move') {
      setBox({ ...ds.box, x: ds.box.x + dx, y: ds.box.y + dy });
    } else {
      const ar = ds.box.w / ds.box.h;
      let w = Math.max(20, ds.box.w + dx);
      const h = w / ar; // lock aspect ratio
      setBox({ ...ds.box, w, h });
    }
  };
  const onPointerUp = () => {
    dragState.current = null;
  };

  // --- Export PNG ------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const onExport = useCallback(async () => {
    if (!result || !box || !creativeObjUrl) {
      toast('Carregue um criativo e posicione a peça antes de exportar.', 'error');
      return;
    }
    setExporting(true);
    try {
      const dsf = result.deviceScaleFactor;
      const bg = new Image();
      bg.crossOrigin = 'anonymous';
      const creative = new Image();
      const load = (img: HTMLImageElement, src: string) =>
        new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('falha ao carregar imagem'));
          img.src = src;
        });
      await Promise.all([load(bg, result.screenshotUrl), load(creative, creativeObjUrl)]);

      const canvas = document.createElement('canvas');
      canvas.width = result.pageWidth * dsf;
      canvas.height = result.pageHeight * dsf;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas indisponível');
      ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
      ctx.drawImage(creative, box.x * dsf, box.y * dsf, box.w * dsf, box.h * dsf);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('falha ao gerar PNG');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const host = (() => { try { return new URL(result.url).hostname.replace(/^www\./, ''); } catch { return 'checkin'; } })();
      a.download = `checkin-${host}-${creativeSize || 'peca'}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('PNG exportado.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Não foi possível exportar (${msg}).`, 'error');
    } finally {
      setExporting(false);
    }
  }, [result, box, creativeObjUrl, creativeSize, toast]);

  const reset = () => {
    setResult(null);
    setBox(null);
    setStatus('idle');
    setErrorMsg('');
  };

  const sc = (v: number) => v * displayScale;

  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <h1 className={styles.title}>Checkin</h1>
        <p className={styles.sub}>
          Capture a página de um publisher, identifique os espaços de mídia e sobreponha o criativo para simular o anúncio.
        </p>
      </header>

      <section className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label}>URL da página</label>
          <input
            className={styles.input}
            type="text"
            placeholder="cnnbrasil.com.br/esportes/automobilismo/"
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && status !== 'capturing' && onCapture()}
          />
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label}>Criativo (imagem)</label>
            <input
              className={styles.fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => e.target.files?.[0] && onCreativeFile(e.target.files[0])}
            />
          </div>
          <div className={styles.fieldSm}>
            <label className={styles.label}>Tamanho</label>
            <input
              className={styles.input}
              type="text"
              placeholder="300x600"
              value={creativeSize}
              onChange={(e) => setCreativeSize(e.target.value)}
            />
          </div>
        </div>

        <button className={styles.primary} onClick={onCapture} disabled={status === 'capturing'}>
          {status === 'capturing' ? 'Capturando…' : 'Capturar página'}
        </button>

        {status === 'capturing' && <p className={styles.progress}>{CAPTURE_MESSAGES[progressIdx]}</p>}
        {status === 'error' && <p className={styles.error}>Falhou: {errorMsg}</p>}
      </section>

      {result && (
        <section className={styles.workspace}>
          <div className={styles.toolbar}>
            <span className={styles.metaText}>
              {result.slots.length} slots · {Math.round(result.meta.durationMs / 1000)}s
              {result.meta.consentHandled ? ' · consent ok' : ''}
            </span>
            <label className={styles.toggle}>
              <input type="checkbox" checked={showSlots} onChange={(e) => setShowSlots(e.target.checked)} />
              Mostrar slots
            </label>
            <div className={styles.spacer} />
            <button className={styles.ghost} onClick={reset}>Novo checkin</button>
            <button className={styles.primarySm} onClick={onExport} disabled={exporting || !box || !creativeObjUrl}>
              {exporting ? 'Exportando…' : 'Exportar PNG'}
            </button>
          </div>

          <div
            className={styles.stage}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <img
              ref={imgRef}
              className={styles.bg}
              src={result.screenshotUrl}
              alt="página capturada"
              onLoad={measure}
              draggable={false}
            />

            {showSlots &&
              result.slots
                .filter((s) => s.confidence >= 0.6)
                .map((s, i) => (
                  <button
                    key={`${s.x}-${s.y}-${i}`}
                    className={`${styles.slot} ${s.recommended ? styles.slotRec : ''}`}
                    style={{ left: sc(s.x), top: sc(s.y), width: sc(s.w), height: sc(s.h) }}
                    onClick={() => snapTo(s)}
                    title={`${s.w}x${s.h}${s.size ? ` (${s.size})` : ''} · ${s.source}`}
                  >
                    <span className={styles.slotTag}>{s.size || `${s.w}x${s.h}`}</span>
                  </button>
                ))}

            {box && creativeObjUrl && (
              <div
                className={styles.creative}
                style={{ left: sc(box.x), top: sc(box.y), width: sc(box.w), height: sc(box.h) }}
                onPointerDown={onPointerDownMove}
              >
                <img src={creativeObjUrl} alt="criativo" draggable={false} />
                <span className={styles.resize} onPointerDown={onPointerDownResize} />
              </div>
            )}
          </div>

          {box == null && creativeObjUrl == null && (
            <p className={styles.hint}>Carregue um criativo acima e clique num slot para posicionar a peça.</p>
          )}
        </section>
      )}
    </main>
  );
}
