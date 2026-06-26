import { useEffect, useState, useCallback } from 'react';
import styles from './MigrationNotice.module.css';

/**
 * Notice shown on the legacy AdBolt site announcing the move to the HYPR
 * Platform. Appears on every page load. Dismissible (X / backdrop / Esc) so
 * users can keep using this site for check-ins and the dashboard of what
 * they've already uploaded — it returns on the next reload.
 */
const NEW_URL = 'https://platform.hypr.mobi/adbolt';

export function MigrationNotice() {
  const [visible, setVisible] = useState(true);

  const dismiss = useCallback(() => {
    setVisible(false);
  }, []);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    },
    [dismiss],
  );

  useEffect(() => {
    if (!visible) return;
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [visible, handleEscape]);

  if (!visible) return null;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="migration-title"
    >
      <div className={styles.card}>
        <button
          className={styles.close}
          onClick={dismiss}
          aria-label="Fechar e continuar no AdBolt atual"
        >
          ✕
        </button>

        <div className={styles.hero} aria-hidden="true">
          <span className={styles.ringOuter} />
          <span className={styles.ringInner} />
          <span className={styles.glyph}>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17 17 7" />
              <path d="M8 7h9v9" />
            </svg>
          </span>
        </div>

        <div className={styles.body}>
          <span className={styles.badge}>Novidade</span>
          <h2 id="migration-title" className={styles.title}>
            O AdBolt mudou de casa
          </h2>
          <p className={styles.text}>
            Agora ele vive dentro da <strong>HYPR Platform</strong>, o dash
            central de ferramentas da HYPR. É lá que fica a versão mais atual.
          </p>

          <a className={styles.cta} href={NEW_URL} onClick={dismiss}>
            Ir para o novo AdBolt
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          </a>

          <button className={styles.secondary} onClick={dismiss}>
            Continuar aqui por enquanto
          </button>

          <p className={styles.note}>
            Você ainda pode usar este site para gerar check-ins e consultar o
            dashboard do que já subiu.
          </p>
        </div>
      </div>
    </div>
  );
}
