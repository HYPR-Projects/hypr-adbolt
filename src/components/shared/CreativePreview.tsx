import { useEffect, useCallback, useState } from 'react';
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

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (data) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
      setIframeLoaded(false);
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

    // 3P Tag (iframe sandbox)
    if (data.type === '3p-tag' && data.tagContent) {
      const srcdoc = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;background:#fff}</style></head>
<body>${data.tagContent}</body></html>`;
      return (
        <div className={styles.previewFrame} style={{ position: 'relative' }}>
          {!iframeLoaded && (
            <div className={styles.loading} style={{ width: renderW, height: renderH, position: 'absolute' }}>
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
            </div>
          )}
          <iframe
            srcDoc={srcdoc}
            sandbox="allow-scripts"
            width={renderW}
            height={renderH}
            style={{ opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.3s' }}
            onLoad={() => setIframeLoaded(true)}
            title={`Preview: ${data.name}`}
          />
          <div className={styles.iframeOverlay} onClick={onClose} />
        </div>
      );
    }

    // HTML5 (iframe sandbox)
    if (data.type === 'html5' && data.html5Content) {
      return (
        <div className={styles.previewFrame} style={{ position: 'relative' }}>
          {!iframeLoaded && (
            <div className={styles.loading} style={{ width: renderW, height: renderH, position: 'absolute' }}>
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
              <div className={styles.loadingDot} />
            </div>
          )}
          <iframe
            srcDoc={data.html5Content}
            sandbox="allow-scripts"
            width={renderW}
            height={renderH}
            style={{ opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.3s' }}
            onLoad={() => setIframeLoaded(true)}
            title={`Preview: ${data.name}`}
          />
          <div className={styles.iframeOverlay} onClick={onClose} />
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

    return (
      <div className={styles.previewFrame}>
        <div className={styles.loading} style={{ width: 300, height: 200 }}>
          Preview não disponível
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
