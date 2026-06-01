import { useCallback, useEffect, useMemo, useState } from 'react';
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
}
interface SnapshotResult {
  shareId: string;
  snapshotUrl: string;
  slots: SlotsMeta;
  meta: { engine?: string; durationMs: number; title: string };
}

const PROGRESS = [
  'Abrindo a página do publisher…',
  'Fechando avisos de cookies e login…',
  'Disparando os anúncios lazy-load…',
  'Encaixando o criativo nos slots reais…',
  'Congelando a página (inline de tudo)…',
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
  const [selectedCreativeId, setSelectedCreativeId] = useState<string | null>(null);
  const [creativeSize, setCreativeSize] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [progressIdx, setProgressIdx] = useState(0);
  const [result, setResult] = useState<SnapshotResult | null>(null);
  const [shareUrl, setShareUrl] = useState('');

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
    setProgressIdx(0);
    const t = setInterval(() => setProgressIdx((i) => Math.min(i + 1, PROGRESS.length - 1)), 7000);
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
    setCreativeSrc(c.thumbnail_url as string);
    setCreativeIsBlob(false);
    setCreativeFile(null);
    setSelectedCreativeId(c.id);
    const natural = parseDimensions(c.dimensions);
    setCreativeSize(c.dimensions || (natural ? `${natural.w}x${natural.h}` : ''));
  }, [creativeSrc, creativeIsBlob]);

  // Resolve a public URL for the creative (library already public; uploads go to storage).
  const resolveCreativeUrl = useCallback(async (): Promise<string> => {
    if (!creativeSrc) throw new Error('selecione um criativo');
    if (!creativeIsBlob) return creativeSrc;
    if (!creativeFile) throw new Error('arquivo do criativo indisponível');
    const ext = (creativeFile.name.split('.').pop() || 'png').toLowerCase();
    const path = `creatives/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const { error } = await supabase.storage
      .from('checkins')
      .upload(path, creativeFile, { contentType: creativeFile.type || 'image/png' });
    if (error) throw new Error(error.message);
    return supabase.storage.from('checkins').getPublicUrl(path).data.publicUrl;
  }, [creativeSrc, creativeIsBlob, creativeFile]);

  // --- Generate snapshot -----------------------------------------------------
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
      if (r.slots.filled === 0) {
        toast('Snapshot gerado, mas nenhum slot foi detectado para este tamanho.', 'error');
      } else {
        toast(`Snapshot gerado · ${r.slots.filled} slot(s) preenchido(s).`, 'success');
      }
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

  const reset = () => {
    setStatus('idle');
    setResult(null);
    setShareUrl('');
    setErrorMsg('');
  };

  return (
    <main className={styles.wrap}>
      <header className={styles.head}>
        <h1 className={styles.title}>Checkin</h1>
        <p className={styles.sub}>
          Gere um preview do criativo encaixado nos espaços de mídia reais da página do publisher.
          O resultado é uma página congelada e navegável, com link para compartilhar.
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
            onKeyDown={(e) => e.key === 'Enter' && status !== 'running' && generate()}
          />
          <label className={styles.proxyToggle}>
            <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
            Usar proxy residencial (sites que bloqueiam mais, consome banda paga)
          </label>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Criativo</label>
          <div className={styles.tabs}>
            <button className={`${styles.tab} ${creativeSource === 'upload' ? styles.tabActive : ''}`} onClick={() => setCreativeSource('upload')}>
              Upload
            </button>
            <button className={`${styles.tab} ${creativeSource === 'library' ? styles.tabActive : ''}`} onClick={() => setCreativeSource('library')}>
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
            </div>
          )}

          {creativeSrc && (
            <div className={styles.creativePreview}>
              <img src={creativeSrc} alt="criativo selecionado" />
              <span>{creativeSize || 'tamanho não detectado'}</span>
            </div>
          )}
        </div>

        <button className={styles.primary} onClick={generate} disabled={status === 'running'}>
          {status === 'running' ? 'Gerando snapshot…' : 'Gerar snapshot'}
        </button>

        {status === 'running' && <p className={styles.progress}>{PROGRESS[progressIdx]}</p>}
        {status === 'error' && <p className={styles.error}>Falhou: {errorMsg}</p>}
      </section>

      {status === 'ready' && result && (
        <section className={styles.workspace}>
          <div className={styles.toolbar}>
            <span className={styles.metaText}>
              {result.slots.filled > 0
                ? `${result.slots.filled} slot(s) preenchido(s)${result.slots.source ? ` · ${result.slots.source}` : ''}`
                : 'nenhum slot detectado para este tamanho'}
              {result.meta.engine ? ` · ${result.meta.engine}` : ''}
              {` · ${Math.round(result.meta.durationMs / 1000)}s`}
            </span>
            <div className={styles.spacer} />
            <button className={styles.ghost} onClick={reset}>Novo checkin</button>
            <button className={styles.primarySm} onClick={copyLink}>Copiar link</button>
          </div>

          <div className={styles.shareRow}>
            <input className={styles.shareInput} readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
            <a className={styles.shareOpen} href={shareUrl} target="_blank" rel="noopener noreferrer">Abrir</a>
          </div>

          <div className={styles.snapshotFrameWrap}>
            <iframe
              className={styles.snapshotFrame}
              src={result.snapshotUrl}
              title="preview do anúncio"
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer"
            />
          </div>
          <p className={styles.hint}>
            Página congelada e self-contained: rola e mostra o anúncio em contexto. O link acima é permanente e abre sem login.
          </p>
        </section>
      )}
    </main>
  );
}
