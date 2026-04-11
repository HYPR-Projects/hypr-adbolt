import { useState, useEffect, useRef, useCallback } from 'react';
import { Modal } from './Modal';
import type { DspType, TrackerFormat } from '@/types';
import { DSP_LABELS } from '@/types';
import { analyzeTracker } from '@/parsers/tracker';
import { normalizeUrl } from '@/lib/utils';
import styles from './BulkModals.module.css';

/* ══════════════════════════════════════════════
   1. Rename Modal
   ══════════════════════════════════════════════ */

interface RenameItem {
  id: number | string;
  name: string;
  dimensions?: string;
  type?: string;
}

interface RenameModalProps {
  visible: boolean;
  onClose: () => void;
  items: RenameItem[];
  onApply: (getNewName: (item: RenameItem, index: number) => string) => void;
}

function getRenamedName(
  name: string,
  prefix: string,
  suffix: string,
  full: string,
  index: number,
  meta: { name: string; dimensions?: string; type?: string },
): string {
  if (full) {
    return full
      .replace(/\{name\}/gi, meta.name)
      .replace(/\{size\}/gi, meta.dimensions || '')
      .replace(/\{type\}/gi, meta.type || '')
      .replace(/\{index\}/gi, String(index + 1));
  }
  return (prefix || '') + name + (suffix || '');
}

export function RenameModal({ visible, onClose, items, onApply }: RenameModalProps) {
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');
  const [full, setFull] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setPrefix('');
      setSuffix('');
      setFull('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const hasInput = !!(prefix || suffix || full);

  const previewItems = items.slice(0, 8).map((item, i) => ({
    old: item.name,
    new: getRenamedName(item.name, prefix, suffix, full, i, item),
  }));

  const handleApply = () => {
    if (!hasInput) return;
    onApply((item, index) => getRenamedName(item.name, prefix, suffix, full, index, item));
    onClose();
  };

  const insertVar = (v: string) => {
    setFull((prev) => prev + v);
  };

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={`Renomear ${items.length} item(ns)`}
      maxWidth="520px"
      footer={
        <div className={styles.footerRow}>
          <button className={styles.btnCancel} onClick={onClose}>Cancelar</button>
          <button className={styles.btnPrimary} disabled={!hasInput} onClick={handleApply}>Aplicar</button>
        </div>
      }
    >
      <div className={styles.field}>
        <label className={styles.label}>Prefixo</label>
        <input
          ref={inputRef}
          className={styles.input}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="Ex: HYPR_"
          disabled={!!full}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Sufixo</label>
        <input
          className={styles.input}
          value={suffix}
          onChange={(e) => setSuffix(e.target.value)}
          placeholder="Ex: _v2"
          disabled={!!full}
        />
      </div>

      <hr className={styles.separator} />

      <div className={styles.field}>
        <label className={styles.label}>
          Nome completo<span className={styles.hint}>(substitui o nome inteiro)</span>
        </label>
        <input
          className={styles.input}
          value={full}
          onChange={(e) => setFull(e.target.value)}
          placeholder="Ex: BRND_{name}_{size}"
          disabled={!!(prefix || suffix)}
        />
        <div className={styles.varsHint}>
          {['{name}', '{size}', '{type}', '{index}'].map((v) => (
            <span key={v} className={styles.varTag} onClick={() => insertVar(v)}>{v}</span>
          ))}
        </div>
      </div>

      <div className={styles.preview}>
        {!hasInput ? (
          <span className={styles.previewEmpty}>Digite um prefixo, sufixo ou nome completo pra ver o preview</span>
        ) : (
          <>
            {previewItems.map((p, i) => (
              <div key={i} className={styles.previewItem}>
                <span className={styles.previewOld}>{p.old}</span>
                <span className={styles.previewArrow}>→</span>
                <span className={styles.previewNew}>{p.new}</span>
              </div>
            ))}
            {items.length > 8 && (
              <div className={styles.previewMore}>...e mais {items.length - 8}</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   2. Find & Replace Modal
   ══════════════════════════════════════════════ */

interface FindReplaceModalProps {
  visible: boolean;
  onClose: () => void;
  count: number;
  onApply: (find: string, replace: string) => void;
}

export function FindReplaceModal({ visible, onClose, count, onApply }: FindReplaceModalProps) {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setFind('');
      setReplace('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const handleApply = () => {
    if (!find) return;
    onApply(find, replace);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={`Find & Replace em ${count} item(ns)`}
      maxWidth="480px"
      footer={
        <div className={styles.footerRow}>
          <button className={styles.btnCancel} onClick={onClose}>Cancelar</button>
          <button className={styles.btnPrimary} disabled={!find} onClick={handleApply}>Substituir</button>
        </div>
      }
    >
      <div className={styles.frRow}>
        <div className={styles.field}>
          <label className={styles.label}>Buscar</label>
          <input
            ref={inputRef}
            className={styles.input}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Texto a buscar..."
            onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
          />
        </div>
        <span className={styles.frArrow}>→</span>
        <div className={styles.field}>
          <label className={styles.label}>Substituir por</label>
          <input
            className={styles.input}
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            placeholder="Texto novo..."
            onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
          />
        </div>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   3. Bulk Tracker Modal (with DSP scope)
   ══════════════════════════════════════════════ */

type TrackerScope = 'all' | DspType[];

interface BulkTrackerModalProps {
  visible: boolean;
  onClose: () => void;
  count: number;
  availableDsps?: DspType[];
  onApply: (url: string, format: TrackerFormat, scope: TrackerScope) => void;
}

const ALL_DSPS: DspType[] = ['xandr', 'dv360', 'stackadapt', 'amazondsp'];

export function BulkTrackerModal({ visible, onClose, count, availableDsps, onApply }: BulkTrackerModalProps) {
  const [raw, setRaw] = useState('');
  const [scope, setScope] = useState<'all' | DspType[]>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  const dsps = availableDsps || ALL_DSPS;

  useEffect(() => {
    if (visible) {
      setRaw('');
      setScope('all');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const toggleScope = useCallback((dsp: DspType | 'all') => {
    if (dsp === 'all') {
      setScope('all');
      return;
    }
    setScope((prev) => {
      if (prev === 'all') {
        // Switch from "all" to individual — select just this one
        return [dsp];
      }
      const arr = [...prev];
      const idx = arr.indexOf(dsp);
      if (idx >= 0) {
        arr.splice(idx, 1);
        return arr.length === 0 ? 'all' : arr;
      }
      arr.push(dsp);
      // If all individual DSPs are selected, switch back to "all"
      if (arr.length === dsps.length) return 'all';
      return arr;
    });
  }, [dsps.length]);

  const handleApply = () => {
    if (!raw.trim()) return;
    const analyzed = analyzeTracker(raw);
    const url = normalizeUrl(analyzed.url);
    onApply(url, analyzed.format, scope);
    onClose();
  };

  const isActive = (dsp: DspType | 'all'): boolean => {
    if (dsp === 'all') return scope === 'all';
    if (scope === 'all') return false;
    return scope.includes(dsp);
  };

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={`Adicionar tracker em ${count} item(ns)`}
      maxWidth="520px"
      footer={
        <div className={styles.footerRow}>
          <button className={styles.btnCancel} onClick={onClose}>Cancelar</button>
          <button className={styles.btnPrimary} disabled={!raw.trim()} onClick={handleApply}>Adicionar</button>
        </div>
      }
    >
      <div className={styles.field}>
        <label className={styles.label}>Pixel URL ou tag HTML</label>
        <input
          ref={inputRef}
          className={styles.input}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Cole a URL ou tag do pixel..."
          onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Aplicar em quais DSPs?</label>
        <div className={styles.scopeRow}>
          <button
            className={`${styles.scopeBtn} ${isActive('all') ? styles.scopeBtnActive : ''}`}
            onClick={() => toggleScope('all')}
          >
            Todas
          </button>
          {dsps.map((dsp) => (
            <button
              key={dsp}
              className={`${styles.scopeBtn} ${isActive(dsp) ? styles.scopeBtnActive : ''}`}
              onClick={() => toggleScope(dsp)}
            >
              {DSP_LABELS[dsp]}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
