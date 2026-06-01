import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFreshToken } from '@/lib/auth-token';
import { useUIStore } from '@/stores/ui';
import { useDashboardStore } from '@/stores/dashboard';
import { supabase } from '@/services/supabase';
import type { Creative } from '@/types';
import styles from './CheckinView.module.css';

type CreativeSource = 'upload' | 'library';
type Status = 'idle' | 'running' | 'ready' | 'error';

interface SlotsMeta {
  filled: number;
  detail: string[];
  source: string | null;
  exact?: number;
  approx?: number;
  slots?: Array<{ id: string; booked: string; mode: string; filled: boolean }>;
}
interface SnapshotResult {
  shareId: string;
  snapshotUrl: string;
  slots: SlotsMeta;
  meta: { engine?: string; durationMs: number; title: string };
}

const STEPS = [
  'Abrindo a página',
  'Limpando avisos',
  'Disparando os anúncios',
  'Encaixando o criativo',
  'Congelando a página',
];

function parseDimensions(dim: string | null): { w: number; h: number } | null {
  if (!dim) return null;
  const m = /(\d+)\s*[x×]\s*(\d+)/.exec(dim);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

// Width the snapshot was captured at (desktop). The in-app preview iframe renders
// at this virtual width and is scaled down to fit the panel, so the layout is
// faithful and never horizontally cropped.
const DESKTOP_W = 1280;

export function CheckinView() {
  const toast = useUIStore((s) => s.toast);
  const creatives = useDashboardStore((s) => s.creatives);
  const loadCreatives = useDashboardStore((s) => s.loadCreatives);
  const dashLoading = useDashboardStore((s) => s.isLoading);

  const [pageUrl, setPageUrl] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [creativeSource, setCreativeSource] = useState<CreativeSource>('library');
  const [librarySearch, setLibrarySearch] = useState('');

  const [creativeSrc, setCreativeSrc] = useState<string | null>(null);
  const [creativeIsBlob, setCreativeIsBlob] = useState(false);
  const [creativeFile, setCreativeFile] = useState<File | null>(null);
  const [selectedCreativeId, setSelectedCreativeId] = useState<string | null>(null);
  const [libraryStoragePath, setLibraryStoragePath] = useState<string | null>(null);
  const [creativeSize, setCreativeSize] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [stepIdx, setStepIdx] = useState(0);
  const [result, setResult] = useState<SnapshotResult | null>(null);
  const [shareUrl, setShareUrl] = useState('');
  const [frameUrl, setFrameUrl] = useState('');
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const [frameDims, setFrameDims] = useState<{ scale: number; w: number; h: number }>({ scale: 1, w: DESKTOP_W, h: 800 });

  // Scale the desktop-width snapshot to fit the result panel (no horizontal crop).
  useEffect(() => {
    if (status !== 'ready') return;
    const el = frameWrapRef.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const scale = w / DESKTOP_W;
      setFrameDims({ scale, w: DESKTOP_W, h: Math.round(h / scale) });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status, frameUrl]);

  // Supabase serves public HTML as text/plain (nosniff), so the iframe can't load
  // the storage URL directly — fetch the HTML and render it via a blob URL, which
  // carries the text/html type.
  useEffect(() => {
    if (status !== 'ready' || !result?.snapshotUrl) return;
    let revoked = false;
    let url = '';
    (async () => {
      try {
        const r = await fetch(result.snapshotUrl);
        const html = await r.text();
        if (revoked) return;
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        setFrameUrl(url);
      } catch {
        // fall back to the raw URL (will show source, but better than blank)
        setFrameUrl(result.snapshotUrl);
      }
    })();
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [status, result]);

  const libraryItems = useMemo(() => {
    const q = librarySearch.toLowerCase().trim();
    return creatives.filter((c) => {
      if (c.creative_type !== 'display' || !c.thumbnail_url) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.dimensions || '').toLowerCase().includes(q);
    });
  }, [creatives, librarySearch]);

  useEffect(() => {
    if (creativeSource === 'library' && creatives.length === 0 && !dashLoading) loadCreatives();
  }, [creativeSource, creatives.length, dashLoading, loadCreatives]);

  useEffect(() => {
    if (status !== 'running') return;
    setStepIdx(0);
    const t = setInterval(() => setStepIdx((i) => Math.min(i + 1, STEPS.length - 1)), 6000);
    return () => clearInterval(t);
  }, [status]);

  // --- Creative selection ----------------------------------------------------
  const onCreativeFile = useCallback((file: File) => {
    if (creativeSrc && creativeIsBlob && creativeSrc.startsWith('blob:')) URL.revokeObjectURL(creativeSrc);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setCreativeSize(`${img.naturalWidth}x${img.naturalHeight}`);
    img.src = url;
    setCreativeSrc(url);
    setCreativeIsBlob(true);
    setCreativeFile(file);
    setSelectedCreativeId(null);
  }, [creativeSrc, creativeIsBlob]);

  const onPickLibrary = useCallback((c: Creative) => {
    if (creativeSrc && creativeIsBlob && creativeSrc.startsWith('blob:')) URL.revokeObjectURL(creativeSrc);
    setCreativeSrc(c.thumbnail_url as string); // thumbnail only for the chip/grid
    setCreativeIsBlob(false);
    setCreativeFile(null);
    setSelectedCreativeId(c.id);
    // Full-res asset lives in the private asset-uploads bucket, referenced by
    // dsp_config.storage_path. Resolved to a signed URL at generate time so the
    // bake uses the real creative, not the 96px grid thumbnail.
    const cfg = typeof c.dsp_config === 'string' ? safeJson(c.dsp_config) : (c.dsp_config || {});
    setLibraryStoragePath((cfg && (cfg as Record<string, unknown>).storage_path as string) || null);
    const natural = parseDimensions(c.dimensions);
    setCreativeSize(c.dimensions || (natural ? `${natural.w}x${natural.h}` : ''));
  }, [creativeSrc, creativeIsBlob]);

  const resolveCreativeUrl = useCallback(async (): Promise<string> => {
    if (!creativeSrc) throw new Error('selecione um criativo');
    if (creativeIsBlob) {
      if (!creativeFile) throw new Error('arquivo do criativo indisponível');
      const ext = (creativeFile.name.split('.').pop() || 'png').toLowerCase();
      const path = `creatives/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const { error } = await supabase.storage
        .from('checkins')
        .upload(path, creativeFile, { contentType: creativeFile.type || 'image/png' });
      if (error) throw new Error(error.message);
      return supabase.storage.from('checkins').getPublicUrl(path).data.publicUrl;
    }
    // Library: prefer the full-res asset (signed URL) over the 96px thumbnail.
    // The snapshot inlines the image as a data URI, so a short-lived signed URL
    // is fine — it only needs to resolve during generation.
    if (libraryStoragePath) {
      const { data, error } = await supabase.storage
        .from('asset-uploads')
        .createSignedUrl(libraryStoragePath, 600);
      if (!error && data?.signedUrl) return data.signedUrl;
    }
    return creativeSrc; // fallback to thumbnail (e.g. tag creatives without an asset)
  }, [creativeSrc, creativeIsBlob, creativeFile, libraryStoragePath]);

  // --- Generate --------------------------------------------------------------
  const canGenerate = !!pageUrl.trim() && !!creativeSrc && status !== 'running';

  const generate = useCallback(async () => {
    let normalized = pageUrl.trim();
    if (!normalized) { toast('Informe a URL da página.', 'error'); return; }
    if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
    if (!creativeSrc) { toast('Selecione um criativo.', 'error'); return; }

    setStatus('running');
    setErrorMsg('');
    setResult(null);
    setShareUrl('');
    try {
      const creativeUrl = await resolveCreativeUrl();
      const token = await getFreshToken();
      const res = await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: normalized, creativeUrl, creativeSize: creativeSize || undefined, proxies: useProxy }),
      });
      const data = await res.json();
      if (!res.ok) {
        const m = data?.message ?? data?.error;
        throw new Error(typeof m === 'string' ? m : `HTTP ${res.status}`);
      }
      const r = data as SnapshotResult;
      setResult(r);
      setShareUrl(`${window.location.origin}/preview/snapshot.html?id=${r.shareId}`);
      setStatus('ready');
      if (r.slots.filled === 0) toast('Snapshot gerado, mas nenhum slot foi detectado para este tamanho.', 'error');
      else toast(`Snapshot gerado · ${r.slots.filled} slot(s) preenchido(s).`, 'success');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [pageUrl, creativeSrc, creativeSize, useProxy, resolveCreativeUrl, toast]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try { await navigator.clipboard.writeText(shareUrl); toast('Link copiado.', 'success'); }
    catch { toast('Não foi possível copiar.', 'error'); }
  }, [shareUrl, toast]);

  const reset = () => { setStatus('idle'); setResult(null); setShareUrl(''); setErrorMsg(''); setFrameUrl(''); };

  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <h1 className={styles.title}>Checkin</h1>
        <p className={styles.sub}>
          Encaixe o criativo nos espaços de mídia reais da página e gere um preview navegável para compartilhar.
        </p>
      </header>

      <div className={styles.layout}>
        {/* ── Config ─────────────────────────────────────────────── */}
        <section className={styles.panel}>
          <div className={styles.field}>
            <label className={styles.label}>URL da página</label>
            <input
              className={styles.input}
              type="text"
              placeholder="cnnbrasil.com.br/esportes/"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canGenerate && generate()}
            />
            <label className={styles.proxyToggle}>
              <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
              Proxy residencial (sites que bloqueiam mais)
            </label>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Criativo</label>
            <div className={styles.tabs}>
              <button className={`${styles.tab} ${creativeSource === 'library' ? styles.tabActive : ''}`} onClick={() => setCreativeSource('library')}>
                Da biblioteca
              </button>
              <button className={`${styles.tab} ${creativeSource === 'upload' ? styles.tabActive : ''}`} onClick={() => setCreativeSource('upload')}>
                Upload
              </button>
            </div>

            {creativeSource === 'upload' ? (
              <div className={styles.uploadRow}>
                <input
                  className={styles.fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  onChange={(e) => e.target.files?.[0] && onCreativeFile(e.target.files[0])}
                />
                <input
                  className={styles.sizeInput}
                  type="text"
                  placeholder="300x250"
                  value={creativeSize}
                  onChange={(e) => setCreativeSize(e.target.value)}
                />
              </div>
            ) : (
              <>
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
                    {libraryItems.slice(0, 80).map((c) => (
                      <button
                        key={c.id}
                        className={`${styles.card} ${selectedCreativeId === c.id ? styles.cardActive : ''}`}
                        onClick={() => onPickLibrary(c)}
                        title={`${c.name} · ${c.dimensions || ''}`}
                      >
                        <img src={c.thumbnail_url as string} alt={c.name} loading="lazy" />
                        <span className={styles.cardMeta}>{c.dimensions || c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {creativeSrc && (
              <div className={styles.selected}>
                <img src={creativeSrc} alt="criativo selecionado" />
                <div className={styles.selectedMeta}>
                  <span className={styles.selectedDim}>{creativeSize || 'tamanho não detectado'}</span>
                  <span className={styles.selectedLabel}>criativo selecionado</span>
                </div>
              </div>
            )}
          </div>

          <button className={styles.primary} onClick={generate} disabled={!canGenerate}>
            {status === 'running' ? 'Gerando…' : 'Gerar snapshot'}
          </button>
        </section>

        {/* ── Result ─────────────────────────────────────────────── */}
        <section className={styles.result}>
          {status === 'idle' && (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="4" width="18" height="14" rx="2" />
                  <rect x="13" y="9" width="6" height="5" rx="0.5" fill="currentColor" stroke="none" opacity="0.35" />
                  <line x1="3" y1="8" x2="21" y2="8" />
                </svg>
              </div>
              <p className={styles.emptyTitle}>O preview aparece aqui</p>
              <p className={styles.emptyText}>Informe a URL, escolha um criativo e gere. O resultado é uma página congelada com o anúncio no slot real.</p>
            </div>
          )}

          {status === 'running' && (
            <div className={styles.loading}>
              <div className={styles.bar}><span /></div>
              <ol className={styles.steps}>
                {STEPS.map((s, i) => (
                  <li key={s} className={i < stepIdx ? styles.stepDone : i === stepIdx ? styles.stepNow : styles.stepWait}>
                    {s}
                  </li>
                ))}
              </ol>
              <p className={styles.loadingHint}>Páginas pesadas levam ~30–60s. Depois o link carrega instantâneo.</p>
            </div>
          )}

          {status === 'error' && (
            <div className={styles.empty}>
              <p className={styles.errorTitle}>Não rolou dessa vez</p>
              <p className={styles.errorText}>{errorMsg}</p>
              <button className={styles.ghost} onClick={reset}>Tentar de novo</button>
            </div>
          )}

          {status === 'ready' && result && (
            <div className={styles.ready}>
              <div className={styles.resultBar}>
                <span className={`${styles.badge} ${result.slots.filled > 0 ? '' : styles.badgeWarn}`}>
                  {result.slots.filled > 0
                    ? `${result.slots.filled} slot(s) · ${result.slots.source || ''}${
                        result.slots.approx ? ` · ${result.slots.exact ?? 0} exato(s), ${result.slots.approx} aprox.` : ''
                      }`
                    : 'nenhum slot detectado'}
                </span>
                <span className={styles.metaText}>{result.meta.engine || ''} · {Math.round(result.meta.durationMs / 1000)}s</span>
                <div className={styles.spacer} />
                <button className={styles.ghost} onClick={reset}>Novo</button>
              </div>

              <div className={styles.shareRow}>
                <input className={styles.shareInput} readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                <button className={styles.copyBtn} onClick={copyLink}>Copiar</button>
                <a className={styles.shareOpen} href={shareUrl} target="_blank" rel="noopener noreferrer">Abrir</a>
              </div>

              <div className={styles.frameWrap} ref={frameWrapRef}>
                <iframe
                  className={styles.frame}
                  src={frameUrl}
                  title="preview do anúncio"
                  sandbox="allow-same-origin"
                  referrerPolicy="no-referrer"
                  style={{
                    width: frameDims.w,
                    height: frameDims.h,
                    transform: `scale(${frameDims.scale})`,
                    transformOrigin: 'top left',
                  }}
                />
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
