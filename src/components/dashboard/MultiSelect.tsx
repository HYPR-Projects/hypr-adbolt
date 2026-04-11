import { useState, useEffect, useRef } from 'react';
import styles from './Dashboard.module.css';

interface MultiSelectProps {
  label: string;
  values: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}

export function MultiSelect({ label, values, selected, onToggle, onClear }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div className={styles.ms} ref={ref}>
      <button className={`${styles.msTrigger} ${selected.size > 0 ? styles.hasSelection : ''}`} onClick={() => setOpen(!open)}>
        {label}{selected.size > 0 && <span className={styles.msBadge}>{selected.size}</span>}
        <svg viewBox="0 0 10 6" width="10" height="10" style={{ opacity: 0.5 }}><path d="M0 0l5 6 5-6z" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className={styles.msDrop}>
          {values.map((v) => (
            <div key={v} className={`${styles.msItem} ${selected.has(v) ? styles.checked : ''}`} onClick={() => onToggle(v)}>
              <span className={styles.msCb}>{selected.has(v) ? '✓' : ''}</span>
              {v}
            </div>
          ))}
          {selected.size > 0 && <div className={styles.msClear} onClick={() => { onClear(); setOpen(false); }}>Limpar filtro</div>}
        </div>
      )}
    </div>
  );
}
