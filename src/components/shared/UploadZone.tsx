import { useRef, useState, useCallback } from 'react';
import styles from './UploadZone.module.css';

interface UploadZoneProps {
  accept: string;
  multiple?: boolean;
  icon?: string;
  text?: React.ReactNode;
  formatHint?: string;
  hasFiles?: boolean;
  fileSummary?: React.ReactNode;
  errorMessage?: string | null;
  onFiles: (files: File[]) => void;
  onClear?: () => void;
  onClearError?: () => void;
}

export function UploadZone({
  accept,
  multiple = false,
  icon = '📄',
  text,
  formatHint,
  hasFiles = false,
  fileSummary,
  errorMessage,
  onFiles,
  onClear,
  onClearError,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragover, setDragover] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragover(false);
    if (onClearError) onClearError();
    if (e.dataTransfer.files.length) {
      onFiles(Array.from(e.dataTransfer.files));
    }
  }, [onFiles, onClearError]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (onClearError) onClearError();
    if (e.target.files?.length) {
      onFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  }, [onFiles, onClearError]);

  const handleClick = () => {
    if (onClearError) onClearError();
    inputRef.current?.click();
  };

  const zoneClasses = [
    styles.zone,
    dragover && styles.dragover,
    hasFiles && styles.hasFiles,
    errorMessage && styles.error,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={zoneClasses}
      onClick={handleClick}
      onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
      onDragLeave={() => setDragover(false)}
      onDrop={handleDrop}
    >
      {hasFiles && fileSummary ? (
        <div className={styles.summary}>
          {fileSummary}
          {onClear && (
            <button
              className={styles.clear}
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              title="Remover todos"
            >
              ✕
            </button>
          )}
        </div>
      ) : (
        <>
          <span className={styles.icon}>{icon}</span>
          <div className={styles.text}>
            {text || <>Arraste o arquivo aqui ou <strong>clique para selecionar</strong></>}
          </div>
          {formatHint && <div className={styles.format}>{formatHint}</div>}
          {errorMessage && <div className={styles.errorMsg}>{errorMessage}</div>}
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleInputChange}
        className={styles.input}
        aria-label="Upload de arquivo"
      />
    </div>
  );
}
