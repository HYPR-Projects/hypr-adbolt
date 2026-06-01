import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFreshToken } from '@/lib/auth-token';
import { useUIStore } from '@/stores/ui';
import { useDashboardStore } from '@/stores/dashboard';
import { supabase } from '@/services/supabase';
import type { Creative } from '@/types';
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
  fullPageHeight?: number;
  truncated?: boolean;
  deviceScaleFactor: number;
  slots: Slot[];
  meta: { consentHandled: boolean; durationMs: number; title: string; engine?: string };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Status = 'idle' | 'capturing' | 'ready' | 'error';
type CreativeSource = 'upload' | 'library';

const CAPTURE_MESSAGES = [
  'Carregando a página…',
  'Fechando o aviso de cookies…',
  'Disparando os anúncios lazy-load…',
  'Identificando os espaços de mídia…',
  'Montando o screenshot…',
];

function parseDimensions(dim: string | null): { w: number; h: number } | null {
  if (!dim) return null;
  const m = /(\d+)\s*[x×]\s*(\d+)/.exec(dim);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

export function CheckinView() {
  const toast = useUIStore((s) => s.toast);
  const creatives = useDashboardStore((s) => s.creatives);
  const loadCreatives = useDashboardStore((s) => s.loadCreatives);
  const dashLoading = useDashboardStore((s) => s.isLoading);

  const [pageUrl, setPageUrl] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [creativeSource, setCreativeSource] = useState<CreativeSource>('upload');
  const [librarySearch, setLibrarySearch] = useState('');

  const [creativeSrc, setCreativeSrc] = useState<string | null>(null);
  const [creativeIsBlob, setCreativeIsBlob] = useState(false);
  const [creativeFile, setCreativeFile] = useState<File | null>(null);
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

  // Display-type creatives with a usable raster thumbnail.
  const libraryItems = useMemo(() => {
    const q = librarySearch.toLowerCase().trim();
    return creatives.filter((c) => {
      if (c.creative_type !== 'display' || !c.thumbnail_url) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.dimensions || '').toLowerCase().includes(q)
      );
    });
  }, [creatives, librarySearch]);

  // Lazy-load the dashboard creatives the first time the library tab is opened.
  useEffect(() => {
    if (creativeSource === 'library' && creatives.length === 0 && !dashLoading) {
      loadCreatives();
    }
  }, [creativeSource, creatives.length, dashLoading, loadCreatives]);

  useEffect(() => {
    if (status !== 'capturing') return;
    setProgressIdx(0);
    const t = setInterval(() => setProgressIdx((i) => Math.min(i + 1, CAPTURE_MESSAGES.length - 1)), 6000);
    return () => clearInterval(t);
  }, [status]);

  const measure = useCallback(() => {
    if (imgRef.current) setDisplayW(imgRef.current.clientWidth);
  }, []);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const displayScale = result && displayW ? displayW / result.pageWidth : 1;

  // --- Creative selection ----------------------------------------------------
  const setCreative = useCallback(
    (src: string, isBlob: boolean, natural: { w: number; h: number } | null, size: string) => {
      setCreativeSrc((prev) => {
        if (prev && creativeIsBlob && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
        return src;
      });
      setCreativeIsBlob(isBlob);
      setCreativeNatural(natural);
      setCreativeSize(size);
    },
    [creativeIsBlob],
  );

  const onCreativeFile = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        setCreativeNatural({ w: img.naturalWidth, h: img.naturalHeight });
        setCreativeSize(`${img.naturalWidth}x${img.naturalHeight}`);
      };
      img.src = url;
      setCreative(url, true, null, '');
      setCreativeFile(file);
    },
    [setCreative],
  );

  const onPickLibrary = useCallback(
    (c: Creative) => {
      const natural = parseDimensions(c.dimensions);
      setCreative(c.thumbnail_url as string, false, natural, c.dimensions || '');
      setCreativeFile(null);
      if (!natural) {
        // Fall back to the image's intrinsic size if dimensions are missing.
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          setCreativeNatural({ w: img.naturalWidth, h: img.naturalHeight });
          setCreativeSize(`${img.naturalWidth}x${img.naturalHeight}`);
        };
        img.src = c.thumbnail_url as string;
      }
    },
    [setCreative],
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
        body: JSON.stringify({ url: normalized, creativeSize: creativeSize || undefined, proxies: useProxy }),
      });
      const data = await res.json();
      if (!res.ok) {
        const m = data?.message ?? data?.error;
        throw new Error(typeof m === 'string' ? m : m ? JSON.stringify(m) : `HTTP ${res.status}`);
      }

      const r = data as CaptureResult;
      setResult(r);
      setStatus('ready');

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
  }, [pageUrl, creativeSize, creativeNatural, useProxy, toast]);

  // --- Snap to a detected slot ----------------------------------------------
  const snapTo = useCallback(
    (slot: Slot) => {
      if (!creativeNatural) {
        setBox({ x: slot.x, y: slot.y, w: slot.w, h: slot.h });
        return;
      }
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

  // --- Drag / resize ---------------------------------------------------------
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
      const w = Math.max(20, ds.box.w + dx);
      setBox({ ...ds.box, w, h: w / ar });
    }
  };
  const onPointerUp = () => {
    dragState.current = null;
  };

  // --- Export PNG ------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const onExport = useCallback(async () => {
    if (!result || !box || !creativeSrc) {
      toast('Selecione um criativo e posicione a peça antes de exportar.', 'error');
      return;
    }
    setExporting(true);
    try {
      const dsf = result.deviceScaleFactor;
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('falha ao carregar imagem'));
          img.src = src;
        });
      const [bg, creative] = await Promise.all([load(result.screenshotUrl), load(creativeSrc)]);

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
  }, [result, box, creativeSrc, creativeSize, toast]);

  // --- Share (hosted public link) -------------------------------------------
  const onShare = useCallback(async () => {
    if (!result || !box || !creativeSrc) {
      toast('Selecione um criativo e posicione a peça antes de compartilhar.', 'error');
      return;
    }
    setSharing(true);
    try {
      // The hosted preview needs a public creative URL. Library creatives are
      // already public; uploaded files must be pushed to storage first.
      let creativeUrl = creativeSrc;
      if (creativeIsBlob) {
        if (!creativeFile) throw new Error('arquivo do criativo indisponível');
        const ext = (creativeFile.name.split('.').pop() || 'png').toLowerCase();
        const path = `creatives/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('checkins')
          .upload(path, creativeFile, { contentType: creativeFile.type || 'image/png', upsert: false });
        if (upErr) throw new Error(upErr.message);
        creativeUrl = supabase.storage.from('checkins').getPublicUrl(path).data.publicUrl;
      }

      const { data, error } = await supabase
        .from('checkins')
        .insert({
          page_url: result.url,
          page_title: result.meta.title,
          screenshot_url: result.screenshotUrl,
          page_width: result.pageWidth,
          page_height: result.pageHeight,
          device_scale_factor: result.deviceScaleFactor,
          creative_url: creativeUrl,
          creative_size: creativeSize || null,
          box,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);

      const link = `${window.location.origin}/preview/checkin.html?id=${data.id}`;
      setShareUrl(link);
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copiado para a área de transferência.', 'success');
      } catch {
        toast('Link gerado.', 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Não foi possível gerar o link (${msg}).`, 'error');
    } finally {
      setSharing(false);
    }
  }, [result, box, creativeSrc, creativeIsBlob, creativeFile, creativeSize, toast]);

  const reset = () => {
    setResult(null);
    setBox(null);
    setStatus('idle');
    setErrorMsg('');
    setShareUrl('');
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
          <label className={styles.proxyToggle}>
            <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
            Usar proxy residencial (sites que bloqueiam mais, consome banda paga)
          </label>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Criativo</label>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${creativeSource === 'upload' ? styles.tabActive : ''}`}
              onClick={() => setCreativeSource('upload')}
            >
              Upload
            </button>
            <button
              className={`${styles.tab} ${creativeSource === 'library' ? styles.tabActive : ''}`}
              onClick={() => setCreativeSource('library')}
            >
              Da biblioteca
            </button>
          </div>

          {creativeSource === 'upload' ? (
            <div className={styles.row}>
              <input
                className={styles.fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => e.target.files?.[0] && onCreativeFile(e.target.files[0])}
              />
              <div className={styles.fieldSm}>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="300x250"
                  value={creativeSize}
                  onChange={(e) => setCreativeSize(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className={styles.library}>
              <input
                className={styles.input}
                type="text"
                placeholder="Buscar por nome ou tamanho…"
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
              />
              {dashLoading ? (
                <p className={styles.hint}>Carregando criativos…</p>
              ) : libraryItems.length === 0 ? (
                <p className={styles.hint}>Nenhum criativo de display com preview encontrado.</p>
              ) : (
                <div className={styles.grid}>
                  {libraryItems.slice(0, 60).map((c) => (
                    <button
                      key={c.id}
                      className={`${styles.card} ${creativeSrc === c.thumbnail_url ? styles.cardActive : ''}`}
                      onClick={() => onPickLibrary(c)}
                      title={`${c.name} · ${c.dimensions || ''}`}
                    >
                      <img src={c.thumbnail_url as string} alt={c.name} loading="lazy" />
                      <span className={styles.cardMeta}>{c.dimensions || c.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
              {result.meta.engine ? ` · ${result.meta.engine}` : ''}
              {result.meta.consentHandled ? ' · consent ok' : ''}
              {result.truncated ? ' · página cortada em 8000px' : ''}
            </span>
            <label className={styles.toggle}>
              <input type="checkbox" checked={showSlots} onChange={(e) => setShowSlots(e.target.checked)} />
              Mostrar slots
            </label>
            <div className={styles.spacer} />
            <button className={styles.ghost} onClick={reset}>Novo checkin</button>
            <button className={styles.ghost} onClick={onShare} disabled={sharing || !box || !creativeSrc}>
              {sharing ? 'Gerando…' : 'Compartilhar link'}
            </button>
            <button className={styles.primarySm} onClick={onExport} disabled={exporting || !box || !creativeSrc}>
              {exporting ? 'Exportando…' : 'Exportar PNG'}
            </button>
          </div>

          {shareUrl && (
            <div className={styles.shareRow}>
              <input className={styles.shareInput} readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
              <a className={styles.shareOpen} href={shareUrl} target="_blank" rel="noopener noreferrer">Abrir</a>
            </div>
          )}

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

            {box && creativeSrc && (
              <div
                className={styles.creative}
                style={{ left: sc(box.x), top: sc(box.y), width: sc(box.w), height: sc(box.h) }}
                onPointerDown={onPointerDownMove}
              >
                <img src={creativeSrc} alt="criativo" draggable={false} />
                <span className={styles.resize} onPointerDown={onPointerDownResize} />
              </div>
            )}
          </div>

          {!creativeSrc && (
            <p className={styles.hint}>Selecione um criativo acima e clique num slot para posicionar a peça.</p>
          )}
        </section>
      )}
    </main>
  );
}
