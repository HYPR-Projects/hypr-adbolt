import { useEffect, useCallback, useState, useRef } from 'react';
import styles from './CreativePreview.module.css';

// ── Types ──

interface PreviewData {
  name: string;
  dimensions: string;
  type: 'display' | 'video' | 'html5' | '3p-tag' | 'survey';
  /** For images/GIFs: object URL or data URL */
  imageUrl?: string;
  /** For videos: object URL */
  videoUrl?: string;
  /** For 3P tags: the JS/HTML tag content */
  tagContent?: string;
  /** For HTML5: the HTML content to render in iframe */
  html5Content?: string;
  /** For HTML5: URL to a hosted HTML preview file */
  html5Url?: string;
  /** MIME type hint for images (to detect GIF) */
  mimeType?: string;
  /** Thumbnail data URL (fallback for dashboard) */
  thumbUrl?: string;
  /** For VAST tags: the complete VAST tag URL for IMA SDK playback */
  vastTagUrl?: string;
  /** For 3P tags ativadas no DV360 — opens the creative in DV360 UI */
  dv360CreativeId?: string;
  dv360AdvertiserId?: string;
}

interface CreativePreviewModalProps {
  data: PreviewData | null;
  onClose: () => void;
}


// ── VAST Player Component (IMA SDK) ──

const IMA_SDK_URL = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';
let imaSdkLoaded = false;
let imaSdkLoading: Promise<void> | null = null;

function loadImaSdk(): Promise<void> {
  if (imaSdkLoaded) return Promise.resolve();
  if (imaSdkLoading) return imaSdkLoading;
  imaSdkLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = IMA_SDK_URL;
    script.onload = () => { imaSdkLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load IMA SDK'));
    document.head.appendChild(script);
  });
  return imaSdkLoading;
}

function VastPlayer({ tagUrl, width, height }: { tagUrl: string; width: number; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const adsManagerRef = useRef<any>(null);

  useEffect(() => {
    let destroyed = false;
    let adsManager: any = null;
    let adsLoader: any = null;

    async function init() {
      try {
        await loadImaSdk();
        if (destroyed) return;

        const google = (window as any).google;
        if (!google?.ima) {
          setStatus('error');
          setErrorMsg('IMA SDK não disponível');
          return;
        }

        const adContainer = containerRef.current;
        const videoElement = videoRef.current;
        if (!adContainer || !videoElement) return;

        const adDisplayContainer = new google.ima.AdDisplayContainer(adContainer, videoElement);
        adDisplayContainer.initialize();

        adsLoader = new google.ima.AdsLoader(adDisplayContainer);

        adsLoader.addEventListener(
          google.ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED,
          (event: any) => {
            if (destroyed) return;
            adsManager = event.getAdsManager(videoElement);
            adsManagerRef.current = adsManager;

            adsManager.addEventListener(google.ima.AdEvent.Type.STARTED, () => {
              if (!destroyed) setStatus('playing');
            });
            adsManager.addEventListener(google.ima.AdEvent.Type.ALL_ADS_COMPLETED, () => {
              if (!destroyed) setStatus('playing');
            });
            adsManager.addEventListener(google.ima.AdErrorEvent.Type.AD_ERROR, (e: any) => {
              if (!destroyed) {
                setStatus('error');
                setErrorMsg(e.getError?.()?.getMessage?.() || 'Erro no ad');
              }
            });

            try {
              adsManager.init(width, height, google.ima.ViewMode.NORMAL);
              adsManager.start();
            } catch (e) {
              if (!destroyed) {
                setStatus('error');
                setErrorMsg('Erro ao iniciar player');
              }
            }
          },
        );

        adsLoader.addEventListener(
          google.ima.AdErrorEvent.Type.AD_ERROR,
          (e: any) => {
            if (!destroyed) {
              setStatus('error');
              setErrorMsg(e.getError?.()?.getMessage?.() || 'Erro ao carregar VAST');
            }
          },
        );

        const adsRequest = new google.ima.AdsRequest();
        adsRequest.adTagUrl = tagUrl;
        adsRequest.linearAdSlotWidth = width;
        adsRequest.linearAdSlotHeight = height;
        adsLoader.requestAds(adsRequest);
      } catch (e) {
        if (!destroyed) {
          setStatus('error');
          setErrorMsg((e as Error).message);
        }
      }
    }

    init();

    return () => {
      destroyed = true;
      try { adsManagerRef.current?.destroy(); } catch {}
    };
  }, [tagUrl, width, height]);

  return (
    <div style={{ position: 'relative', width, height, background: '#000', borderRadius: 'var(--r-xs)', overflow: 'hidden' }}>
      <video
        ref={videoRef}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        playsInline
        muted
      />
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0, zIndex: 1 }}
      />
      {status === 'loading' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 8, zIndex: 2,
          background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '0.82rem',
        }}>
          <div className={styles.loadingDot} />
          <span>Carregando VAST...</span>
        </div>
      )}
      {status === 'error' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 8, zIndex: 2,
          background: 'rgba(0,0,0,0.85)', color: '#fff', fontSize: '0.78rem',
          padding: 20, textAlign: 'center',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FF5252" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>
          <span style={{ fontWeight: 500 }}>Preview indisponível</span>
          <span style={{ opacity: 0.6, maxWidth: 280, wordBreak: 'break-word' }}>{errorMsg || 'VAST tag não pôde ser renderizada'}</span>
          <span style={{ opacity: 0.4, fontSize: '0.68rem', marginTop: 4 }}>Verifique a tag diretamente no ad server</span>
        </div>
      )}
    </div>
  );
}

// ── Thumbnail Component ──

interface PreviewThumbProps {
  thumb?: string;
  type: string;
  name: string;
  isVideo?: boolean;
  onClick: () => void;
}

export function PreviewThumb({ thumb, type, name, isVideo, onClick }: PreviewThumbProps) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  };

  if (thumb) {
    return (
      <div className={styles.thumbWrap} onClick={handleClick} title={`Preview: ${name}`}>
        <img
          src={thumb}
          alt={name}
          loading="lazy"
          className={styles.thumbImg}
        />
        {isVideo && (
          <div className={styles.playBadge}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </div>
        )}
      </div>
    );
  }

  // Inline icon button for tags/HTML5 — same visual weight as badges in the row
  return (
    <button className={styles.previewBtn} onClick={handleClick} type="button" title={`Preview: ${name}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

// ── Helper: encode UTF-8 strings as URL-safe base64 ──
function base64UrlEncode(str: string): string {
  // unescape(encodeURIComponent(...)) is the classic trick to get a valid
  // byte-string for btoa() even when the input has multibyte characters.
  const utf8 = unescape(encodeURIComponent(str));
  return btoa(utf8)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── Helper: open tag content in a real HTTPS popup via /preview/ ──
//
// 3P adserver loaders (dcmads.js, Sizmek, Flashtalking, etc.) probe
// window.location.protocol and refuse to run when it's anything other than
// http/https — which rules out both iframe srcdoc (opaque origin) and blob:
// URLs (`location.protocol === "blob:"`). The fix is to serve the tag from a
// real static file on our own domain; `/preview/index.html` does exactly that
// and pulls the tag out of the URL fragment so nothing hits the server.
function openTagInPopup(tagContent: string, name: string, w: number, h: number): void {
  const pad = 40;
  const popW = w + pad;
  const popH = h + pad;
  const left = Math.round((window.screen.width - popW) / 2);
  const top = Math.round((window.screen.height - popH) / 2);
  const url = `/preview/#tag=${base64UrlEncode(tagContent)}&w=${w}&h=${h}&name=${encodeURIComponent(name)}`;
  const popup = window.open(
    url,
    'tag_preview_' + Date.now(),
    `width=${popW},height=${popH},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`,
  );
  if (!popup) {
    alert('O popup foi bloqueado pelo navegador. Permita popups para adbolt.hypr.mobi.');
  }
}


// ── 3P Tag Frame (open/write/close pattern) ──────────────────────────────────
//
// The definitive way to preview a third-party ad tag:
//
//   1. Create a blank <iframe> (no src). An iframe with no src inherits the
//      parent's origin, so the parent can access iframe.contentDocument.
//   2. Call contentDocument.open() to start a fresh parse stream in the iframe.
//   3. contentDocument.write(htmlContainingTheTag) while the stream is open.
//      Every <script> inside runs during the iframe's parse — including
//      external ones like dcmads.js — and their own document.write() calls
//      land in the same open stream instead of hitting the async-write block.
//   4. contentDocument.close() to signal EOF.
//
// This is what test-a-tag.com, DV360 Studio preview, and CM360's in-product
// tag tester all do under the hood. It is mode-agnostic (dcmads.js script mode
// and iframe mode both work), network-agnostic (HYPRN, DV360BR, any other),
// and ad-server-agnostic (Sizmek, Flashtalking, Innovid all rely on the same
// assumption: "my scripts run during a real document parse").
//
// srcdoc, iframe with src=embed-page, and blob: URLs all fail this test
// because either their protocol is not https: (dcmads.js aborts) or their
// scripts are appended post-parse (document.write blocked).
//
interface ThreePartyTagFrameProps {
  tagContent: string;
  tagW: number;
  tagH: number;
  scale: number;
  name: string;
}

function ThreePartyTagFrame({ tagContent, tagW, tagH, scale, name }: ThreePartyTagFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base target="_blank">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{width:${tagW}px;height:${tagH}px;overflow:hidden;background:transparent}
</style>
</head>
<body>${tagContent}</body>
</html>`;

    try {
      doc.open();
      doc.write(html);
      doc.close();
    } catch (e) {
      console.error('[preview] open/write/close failed:', e);
    }
  }, [tagContent, tagW, tagH]);

  return (
    <iframe
      ref={iframeRef}
      title={`Preview: ${name}`}
      width={tagW}
      height={tagH}
      style={scale < 1 ? { transformOrigin: '0 0', transform: `scale(${scale})`, border: 'none', display: 'block' } : { border: 'none', display: 'block' }}
    />
  );
}

// ── Full Preview Modal ──

export function CreativePreviewModal({ data, onClose }: CreativePreviewModalProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  // Track which preview we're showing to force iframe re-mount
  const [previewKey, setPreviewKey] = useState(0);
  // Fetched HTML content for html5Url previews (bypasses Supabase text/plain content-type)
  const [fetchedHtml, setFetchedHtml] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState(false);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (data) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
      // Reset iframe state and bump key for fresh mount
      setIframeLoaded(false);
      setPreviewKey((k) => k + 1);
      setFetchedHtml(null);
      setFetchError(false);

      // If we have an html5Url, fetch content for srcdoc rendering
      // (Supabase Storage serves .html as text/plain which breaks iframe src)
      if (data.type === 'html5' && data.html5Url) {
        fetch(data.html5Url)
          .then((r) => r.ok ? r.text() : Promise.reject('HTTP ' + r.status))
          .then((html) => setFetchedHtml(html))
          .catch(() => setFetchError(true));
      }

      return () => {
        document.removeEventListener('keydown', handleEscape);
        document.body.style.overflow = '';
      };
    }
  }, [data, handleEscape]);

  if (!data) return null;

  const [w, h] = (data.dimensions || '0x0').split('x').map(Number);

  // Scale dimensions to fit viewport
  const maxW = window.innerWidth * 0.85;
  const maxH = window.innerHeight * 0.75;
  const scale = Math.min(maxW / (w || 300), maxH / (h || 250), 1);
  const renderW = Math.round((w || 300) * scale);
  const renderH = Math.round((h || 250) * scale);

  const renderPreview = () => {
    // Image (JPG, PNG, GIF)
    if (data.type === 'display' && data.imageUrl) {
      const isPng = data.mimeType?.includes('png') || data.imageUrl.includes('.png');
      return (
        <div className={`${styles.previewFrame} ${isPng ? styles.checkerboard : ''}`}>
          <img src={data.imageUrl} alt={data.name} style={{ maxWidth: renderW, maxHeight: renderH }} />
        </div>
      );
    }

    // Video
    if (data.type === 'video' && data.videoUrl) {
      return (
        <div className={styles.previewFrame}>
          <video
            src={data.videoUrl}
            controls
            autoPlay
            muted
            style={{ width: renderW, height: renderH }}
          />
        </div>
      );
    }

    // VAST Tag — render via IMA SDK
    if (data.vastTagUrl) {
      return (
        <div className={styles.previewFrame}>
          <VastPlayer
            tagUrl={data.vastTagUrl}
            width={renderW}
            height={renderH}
          />
        </div>
      );
    }

    // Survey (Typeform) — open in sized popup to bypass X-Frame-Options
    if (data.type === 'survey' && data.tagContent) {
      const tagW = w || 300;
      const tagH = h || 250;
      const pad = 40;
      const popW = tagW + pad;
      const popH = tagH + pad;
      const left = Math.round((window.screen.width - popW) / 2);
      const top = Math.round((window.screen.height - popH) / 2);
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview: ${data.name}</title><style>*{margin:0;padding:0}body{display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;background:#f4f4f4}</style></head><body>${data.tagContent}</body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      const popup = window.open(
        blobUrl,
        'survey_preview',
        `width=${popW},height=${popH},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`,
      );
      // Revoke blob URL after popup loads to free memory
      if (popup) {
        popup.addEventListener('load', () => URL.revokeObjectURL(blobUrl));
      } else {
        // Popup blocked — revoke immediately and notify user
        URL.revokeObjectURL(blobUrl);
        alert('O popup de preview foi bloqueado pelo navegador. Permita popups para adbolt.hypr.mobi.');
        return null;
      }
      // Auto-close the modal since content is in the popup
      onClose();
      return null;
    }

    // 3P Tag — rendered by <ThreePartyTagFrame />, which uses the document
    // open/write/close pattern to inject the tag into a same-origin iframe.
    // See the component below for the reasoning.
    if (data.type === '3p-tag' && data.tagContent) {
      const tagW = w || 300;
      const tagH = h || 250;
      return (
        <div className={styles.previewFrame} style={{ width: renderW, height: renderH, overflow: 'hidden' }}>
          <ThreePartyTagFrame
            key={`tag-${previewKey}`}
            tagContent={data.tagContent}
            tagW={tagW}
            tagH={tagH}
            scale={scale}
            name={data.name}
          />
        </div>
      );
    }

    // HTML5 via URL (dashboard — fetch content and render as srcdoc)
    if (data.type === 'html5' && data.html5Url) {
      if (fetchedHtml) {
        return (
          <div className={styles.previewFrame}>
            {!iframeLoaded && (
              <div className={styles.loading} style={{ width: renderW, height: renderH, position: 'absolute' }}>
                <div className={styles.loadingDot} />
                <div className={styles.loadingDot} />
                <div className={styles.loadingDot} />
              </div>
            )}
            <iframe
              key={`h5url-${previewKey}`}
              srcDoc={fetchedHtml}
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              width={renderW}
              height={renderH}
              style={{ display: 'block', border: 'none', opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.3s' }}
              onLoad={() => setIframeLoaded(true)}
              title={`Preview: ${data.name}`}
            />
          </div>
        );
      }
      // Still loading or failed
      if (fetchError && data.thumbUrl) {
        return (
          <div className={`${styles.previewFrame} ${styles.checkerboard}`}>
            <img src={data.thumbUrl} alt={data.name} style={{ maxWidth: renderW, imageRendering: 'auto' }} />
          </div>
        );
      }
      return (
        <div className={styles.previewFrame}>
          <div className={styles.loading} style={{ width: renderW, height: renderH }}>
            {fetchError ? 'Preview indisponível' : (
              <>
                <div className={styles.loadingDot} />
                <div className={styles.loadingDot} />
                <div className={styles.loadingDot} />
              </>
            )}
          </div>
        </div>
      );
    }

    // HTML5 via srcdoc (wizard — inline content)
    if (data.type === 'html5' && data.html5Content) {
      return (
        <div className={styles.previewFrame}>
          {!iframeLoaded && (
            <div className={styles.loading} style={{ width: renderW, height: renderH, position: 'absolute' }}>
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
            </div>
          )}
          <iframe
            key={`h5doc-${previewKey}`}
            srcDoc={data.html5Content}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            width={renderW}
            height={renderH}
            style={{ display: 'block', border: 'none', opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.3s' }}
            onLoad={() => setIframeLoaded(true)}
            title={`Preview: ${data.name}`}
          />
        </div>
      );
    }

    // Fallback: thumbnail only
    if (data.thumbUrl) {
      return (
        <div className={`${styles.previewFrame} ${styles.checkerboard}`}>
          <img src={data.thumbUrl} alt={data.name} style={{ maxWidth: renderW, imageRendering: 'auto' }} />
        </div>
      );
    }

    // No preview available — styled placeholder
    return (
      <div className={styles.previewFrame}>
        <div className={styles.noPreview} style={{ width: Math.max(renderW, 280), height: Math.max(renderH, 160) }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <span>Preview não disponível</span>
          <span className={styles.noPreviewSub}>{data.dimensions} · {data.type === '3p-tag' ? '3P Tag' : data.type}</span>
        </div>
      </div>
    );
  };

  const typeLabel = data.type === '3p-tag' ? '3P Tag' : data.type === 'html5' ? 'HTML5' : data.type === 'survey' ? 'Survey' : data.type;

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.container}>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Fechar preview">✕</button>
        {renderPreview()}
        <div className={styles.info}>
          <span className={styles.infoName} title={data.name}>{data.name}</span>
          <span className={styles.infoDot} />
          <span className={styles.infoDims}>{data.dimensions}</span>
          <span className={styles.infoDot} />
          <span className={styles.infoType}>{typeLabel}</span>
          {data.type === '3p-tag' && (
            <>
              <span className={styles.infoDot} />
              {data.dv360CreativeId && data.dv360AdvertiserId ? (
                <a
                  className={styles.infoAction}
                  href={`https://displayvideo.google.com/ng_nav/#/advertiser/${data.dv360AdvertiserId}/creative/${data.dv360CreativeId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Abre o criativo no DV360 — o preview oficial do ad server renderiza a tag"
                >
                  Ver no DV360 ↗
                </a>
              ) : data.tagContent ? (
                <button
                  type="button"
                  className={styles.infoAction}
                  onClick={() => openTagInPopup(data.tagContent!, data.name, w || 300, h || 250)}
                  title="Abre a tag numa janela sem sandbox"
                >
                  Abrir em nova janela ↗
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}