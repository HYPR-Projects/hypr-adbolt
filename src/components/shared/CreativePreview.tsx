import { useEffect, useCallback, useState, useRef } from 'react';
import styles from './CreativePreview.module.css';

// ── Types ──

interface PreviewData {
  name: string;
  dimensions: string;
  type: 'display' | 'video' | 'html5' | '3p-tag';
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
}

interface CreativePreviewModalProps {
  data: PreviewData | null;
  onClose: () => void;
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

// ── Full Preview Modal ──

export function CreativePreviewModal({ data, onClose }: CreativePreviewModalProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  // Track which preview we're showing to force iframe re-mount
  const [previewKey, setPreviewKey] = useState(0);
  // Track object URLs for cleanup
  const objectUrlRef = useRef<string | null>(null);

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
      return () => {
        document.removeEventListener('keydown', handleEscape);
        document.body.style.overflow = '';
        // Revoke any object URL from this preview session
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
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

    // 3P Tag (iframe sandbox)
    if (data.type === '3p-tag' && data.tagContent) {
      const srcdoc = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><base target="_blank"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff}</style></head>
<body>${data.tagContent}</body></html>`;
      return (
        <div className={styles.previewFrame} style={{ width: renderW, height: renderH, overflow: 'hidden' }}>
          {!iframeLoaded && (
            <div className={styles.loading} style={{ width: renderW, height: renderH, position: 'absolute' }}>
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
            </div>
          )}
          <iframe
            key={`tag-${previewKey}`}
            srcDoc={srcdoc}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            scrolling="no"
            width={renderW}
            height={renderH}
            style={{ display: 'block', width: renderW, height: renderH, border: 'none', clipPath: `inset(0 0 0 0)`, opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.3s' }}
            onLoad={() => setIframeLoaded(true)}
            title={`Preview: ${data.name}`}
          />
        </div>
      );
    }

    // HTML5 via URL (dashboard — hosted preview file)
    if (data.type === 'html5' && data.html5Url) {
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
            src={data.html5Url}
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

  const typeLabel = data.type === '3p-tag' ? '3P Tag' : data.type === 'html5' ? 'HTML5' : data.type;

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
        </div>
      </div>
    </div>
  );
}
