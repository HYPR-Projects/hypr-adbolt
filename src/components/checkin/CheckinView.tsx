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

type CreativeKind = 'display' | 'video' | 'html5' | 'tag' | 'survey';

// Classify a raw Creative the same way the dashboard preview does, so the
// checkin library shows the whole base with correct type badges.
function classifyCreative(c: Creative): CreativeKind {
  const isZip = !!(c.asset_filename?.toLowerCase().endsWith('.zip') || c.asset_mime_type?.includes('zip'));
  if (c.creative_type === 'html5' || isZip) return 'html5';
  if (c.creative_type === 'video' || c.asset_mime_type?.startsWith('video') || c.vast_tag) return 'video';
  const tag = c.js_tag || '';
  if (tag && !tag.startsWith('http')) return tag.includes('form.typeform.com') ? 'survey' : 'tag';
  return 'display';
}

// Phase status: which kinds the snapshot can bake today.
// display + html5 are live; tag/video/survey land in later phases.
const BAKEABLE_KINDS: Record<CreativeKind, boolean> = {
  display: true, html5: true, tag: true, survey: true, video: true,
};
const KIND_LABEL: Record<CreativeKind, string> = {
  display: 'DISPLAY', html5: 'HTML5', video: 'VÍDEO', tag: 'TAG', survey: 'SURVEY',
};

// Width the snapshot was captured at (desktop). The in-app preview iframe renders
// at this virtual width and is scaled down to fit the panel, so the layout is
// faithful and never horizontally cropped.
const DESKTOP_W = 1280;

const URL_PRESETS = [
  'https://www.omelete.com.br/',
  'https://www.globo.com/',
  'https://vogue.globo.com/',
  'https://ge.globo.com/',
  'https://www.tudogostoso.com.br/',
  'https://www.uol.com.br/',
  'https://www.cnnbrasil.com.br/',
  'https://www.tecmundo.com.br/',
];

function faviconUrl(u: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(u).hostname}`;
  } catch {
    return '';
  }
}

export function CheckinView() {
  const toast = useUIStore((s) => s.toast);
  const creatives = useDashboardStore((s) => s.creatives);
  const loadCreatives = useDashboardStore((s) => s.loadCreatives);
  const dashLoading = useDashboardStore((s) => s.isLoading);

  const [pageUrl, setPageUrl] = useState('');
  const [urlMenuOpen, setUrlMenuOpen] = useState(false);
  const urlComboRef = useRef<HTMLDivElement>(null);
  const [useProxy, setUseProxy] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [creativeSource, setCreativeSource] = useState<CreativeSource>('library');
  const [librarySearch, setLibrarySearch] = useState('');

  const [creativeSrc, setCreativeSrc] = useState<string | null>(null);
  const [creativeIsBlob, setCreativeIsBlob] = useState(false);
  const [creativeFile, setCreativeFile] = useState<File | null>(null);
  const [selectedCreativeId, setSelectedCreativeId] = useState<string | null>(null);
  const [libraryStoragePath, setLibraryStoragePath] = useState<string | null>(null);
  const [creativeKind, setCreativeKind] = useState<CreativeKind>('display');
  const [creativeBakeSrc, setCreativeBakeSrc] = useState<string | null>(null); // html5: hosted url to render
  // video: storage path of the playable asset (mp4), kept even when a poster
  // exists, so the share preview can mount a live <video controls> on top of
  // the frozen poster. Null for VAST-only / non-asset video → stays frozen.
  const [videoLivePath, setVideoLivePath] = useState<string | null>(null);
  // video: the VAST tag (when the creative is VAST, not an mp4 asset). The
  // snapshot resolves its MP4 MediaFile server-side so the share preview can
  // play it in a plain <video> without firing the VAST's tracking beacons.
  const [videoVastTag, setVideoVastTag] = useState<string | null>(null);
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

  // Close the URL preset dropdown when clicking outside it.
  useEffect(() => {
    if (!urlMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (urlComboRef.current && !urlComboRef.current.contains(e.target as Node)) {
        setUrlMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [urlMenuOpen]);

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
    return creatives
      .map((c) => ({ c, kind: classifyCreative(c) }))
      .filter(({ c }) => {
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
    setCreativeKind('display');
    setCreativeBakeSrc(null);
    setLibraryStoragePath(null);
    setVideoLivePath(null);
    setVideoVastTag(null);
  }, [creativeSrc, creativeIsBlob]);

  const onPickLibrary = useCallback((c: Creative) => {
    const kind = classifyCreative(c);
    if (!BAKEABLE_KINDS[kind]) {
      toast(`${KIND_LABEL[kind]}: preview ainda não suportado (chega numa próxima fase).`, 'error');
      return;
    }
    if (creativeSrc && creativeIsBlob && creativeSrc.startsWith('blob:')) URL.revokeObjectURL(creativeSrc);
    setCreativeIsBlob(false);
    setCreativeFile(null);
    setSelectedCreativeId(c.id);
    setCreativeKind(kind);
    setCreativeSrc((c.thumbnail_url as string) || null); // thumbnail for the chip/grid
    const cfg = typeof c.dsp_config === 'string' ? safeJson(c.dsp_config) : (c.dsp_config || {});
    const storagePath = (cfg && (cfg as Record<string, unknown>).storage_path as string) || null;
    setVideoLivePath(null);
    setVideoVastTag(null);

    if (kind === 'html5') {
      // Hosted preview URL lives in js_tag (http). The snapshot renders it
      // headless and bakes a frame — no static asset to resolve.
      const url = (c.js_tag && c.js_tag.startsWith('http')) ? c.js_tag : null;
      setCreativeBakeSrc(url);
      setLibraryStoragePath(null);
      if (!url) toast('HTML5 sem URL de preview hospedada — não dá pra renderizar.', 'error');
    } else if (kind === 'tag' || kind === 'survey') {
      // The bake source is the tag content itself (js_tag, non-http). The
      // snapshot resolves CM360 placements via ad-proxy or renders the tag
      // headless and screenshots a frame.
      const content = (c.js_tag && !c.js_tag.startsWith('http')) ? c.js_tag : null;
      setCreativeBakeSrc(content);
      setLibraryStoragePath(null);
      if (!content) toast(`${KIND_LABEL[kind]} sem conteúdo de tag — não dá pra renderizar.`, 'error');
    } else if (kind === 'video') {
      // Frozen bake = poster (thumbnail) + play overlay; VAST tag, then mp4 as
      // fallback bake sources. Independently, keep the mp4 storage path so the
      // share preview can mount a live <video controls>. VAST-only video has no
      // asset → no live layer, stays frozen.
      const poster = (c.thumbnail_url as string) || null;
      if (poster) {
        setCreativeBakeSrc(poster);
        setLibraryStoragePath(null);
      } else if (c.vast_tag) {
        setCreativeBakeSrc(c.vast_tag);
        setLibraryStoragePath(null);
      } else {
        setCreativeBakeSrc(null);
        setLibraryStoragePath(storagePath);
      }
      setVideoLivePath(storagePath);
      setVideoVastTag(c.vast_tag || null);
    } else {
      // display: full-res asset (signed URL) resolved at generate time.
      setCreativeBakeSrc(null);
      setLibraryStoragePath(storagePath);
    }
    const natural = parseDimensions(c.dimensions);
    setCreativeSize(c.dimensions || (natural ? `${natural.w}x${natural.h}` : ''));
  }, [creativeSrc, creativeIsBlob, toast]);

  const resolveCreativeUrl = useCallback(async (): Promise<string> => {
    if (!creativeSrc && !creativeBakeSrc) throw new Error('selecione um criativo');
    // html5 / tag / survey: the snapshot renders the creative headless.
    if (creativeKind === 'html5' || creativeKind === 'tag' || creativeKind === 'survey') {
      if (!creativeBakeSrc) throw new Error('criativo sem fonte para preview');
      return creativeBakeSrc;
    }
    // video: poster (thumbnail) if available, else the signed mp4.
    if (creativeKind === 'video') {
      if (creativeBakeSrc) return creativeBakeSrc;
      if (libraryStoragePath) {
        const { data, error } = await supabase.storage.from('asset-uploads').createSignedUrl(libraryStoragePath, 600);
        if (!error && data?.signedUrl) return data.signedUrl;
      }
      if (creativeSrc) return creativeSrc;
      throw new Error('vídeo sem poster ou arquivo para preview');
    }
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
    if (!creativeSrc) throw new Error('criativo sem fonte para preview');
    return creativeSrc; // fallback to thumbnail (e.g. tag creatives without an asset)
  }, [creativeSrc, creativeIsBlob, creativeFile, libraryStoragePath, creativeKind, creativeBakeSrc]);

  // --- Generate --------------------------------------------------------------
  const hasCreative = !!creativeSrc || !!creativeBakeSrc || !!libraryStoragePath;
  const canGenerate = !!pageUrl.trim() && hasCreative && status !== 'running';

  const urlOptions = useMemo(() => {
    const q = pageUrl.trim().toLowerCase();
    return q ? URL_PRESETS.filter((u) => u.toLowerCase().includes(q)) : URL_PRESETS;
  }, [pageUrl]);

  const generate = useCallback(async () => {
    let normalized = pageUrl.trim();
    if (!normalized) { toast('Informe a URL da página.', 'error'); return; }
    if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
    if (!creativeSrc && !creativeBakeSrc && !libraryStoragePath) { toast('Selecione um criativo.', 'error'); return; }

    setStatus('running');
    setErrorMsg('');
    setResult(null);
    setShareUrl('');
    try {
      const creativeUrl = await resolveCreativeUrl();

      // Video: prefer a web-optimized transcode served from the public CDN,
      // reusing the same Cloudinary pipeline the DSP activation uses (720p,
      // ~2500kbps). Transcoded once per asset and cached. On any failure, fall
      // back to a long-lived signed URL of the raw asset (current behavior).
      let liveUrl: string | undefined;
      if (!freeze && creativeKind === 'video' && videoLivePath) {
        try {
          const { data: tx } = await supabase.functions.invoke('checkin-transcode', {
            body: { storagePath: videoLivePath },
          });
          if (tx && typeof (tx as { url?: unknown }).url === 'string') liveUrl = (tx as { url: string }).url;
        } catch { /* fall back to the raw asset below */ }
        if (!liveUrl) {
          const { data: vData, error: vErr } = await supabase.storage
            .from('asset-uploads')
            .createSignedUrl(videoLivePath, 60 * 60 * 24 * 365);
          if (!vErr && vData?.signedUrl) liveUrl = vData.signedUrl;
        }
      }

      const token = await getFreshToken();
      const res = await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          url: normalized, creativeUrl, creativeSize: creativeSize || undefined, creativeKind,
          liveUrl,
          vastTag: (!freeze && creativeKind === 'video' && !liveUrl && videoVastTag) ? videoVastTag : undefined,
          freeze, proxies: useProxy,
        }),
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
  }, [pageUrl, creativeSrc, creativeBakeSrc, libraryStoragePath, videoLivePath, videoVastTag, creativeKind, creativeSize, useProxy, freeze, resolveCreativeUrl, toast]);

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
            <div className={styles.urlCombo} ref={urlComboRef}>
              <input
                className={styles.input}
                type="text"
                placeholder="cnnbrasil.com.br/esportes/"
                value={pageUrl}
                autoComplete="off"
                onChange={(e) => { setPageUrl(e.target.value); setUrlMenuOpen(true); }}
                onFocus={() => setUrlMenuOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canGenerate) { setUrlMenuOpen(false); generate(); }
                  if (e.key === 'Escape') setUrlMenuOpen(false);
                }}
              />
              {urlMenuOpen && urlOptions.length > 0 && (
                <div className={styles.urlMenu} role="listbox">
                  {urlOptions.map((u) => (
                    <button
                      key={u}
                      type="button"
                      className={styles.urlOption}
                      onClick={() => { setPageUrl(u); setUrlMenuOpen(false); }}
                    >
                      <img
                        className={styles.urlFavicon}
                        src={faviconUrl(u)}
                        alt=""
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                      />
                      <span>{u.replace(/^https?:\/\//, '')}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label className={styles.proxyToggle}>
              <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
              Proxy residencial BR (preview como o público brasileiro vê; também destrava sites com anti-bot)
            </label>
            <label className={styles.proxyToggle}>
              <input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} />
              Congelar para compartilhar (imagem estática, sem depender do servidor)
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
                  <p className={styles.hint}>Nenhum criativo encontrado.</p>
                ) : (
                  <div className={styles.grid}>
                    {libraryItems.slice(0, 120).map(({ c, kind }) => {
                      const bakeable = BAKEABLE_KINDS[kind];
                      return (
                        <button
                          key={c.id}
                          className={`${styles.card} ${selectedCreativeId === c.id ? styles.cardActive : ''}`}
                          onClick={() => onPickLibrary(c)}
                          title={`${c.name} · ${c.dimensions || ''} · ${KIND_LABEL[kind]}${bakeable ? '' : ' (em breve)'}`}
                          style={{ position: 'relative', opacity: bakeable ? 1 : 0.45 }}
                        >
                          {c.thumbnail_url
                            ? <img src={c.thumbnail_url as string} alt={c.name} loading="lazy" />
                            : <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', aspectRatio: '16/9', fontSize: 11, color: 'var(--ts, #8BA3AF)' }}>{KIND_LABEL[kind]}</span>}
                          <span style={{ position: 'absolute', top: 6, left: 6, fontSize: 9, fontWeight: 700, letterSpacing: '.04em', padding: '2px 6px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#fff' }}>{KIND_LABEL[kind]}{bakeable ? '' : ' · em breve'}</span>
                          <span className={styles.cardMeta}>
                            <span className={styles.cardName}>{c.name}</span>
                            <span className={styles.cardDim}>{c.dimensions || KIND_LABEL[kind]}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {(creativeSrc || creativeBakeSrc || libraryStoragePath) && (
              <div className={styles.selected}>
                {creativeSrc
                  ? <img src={creativeSrc} alt="criativo selecionado" />
                  : <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 48, fontSize: 11, fontWeight: 700 }}>{KIND_LABEL[creativeKind]}</span>}
                <div className={styles.selectedMeta}>
                  <span className={styles.selectedDim}>{creativeSize || 'tamanho não detectado'}{creativeKind !== 'display' ? ` · ${KIND_LABEL[creativeKind]}` : ''}</span>
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
              <p className={styles.emptyText}>Informe a URL, escolha um criativo e gere. Tags, surveys e HTML5 rodam ao vivo no slot real; display e vídeo entram como imagem.</p>
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
                  sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-storage-access-by-user-activation"
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
