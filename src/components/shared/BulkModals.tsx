import { useState, useEffect, useRef, useCallback } from 'react';
import { Modal } from './Modal';
import type { DspType, TrackerFormat, VastEventType } from '@/types';
import { DSP_LABELS, VAST_EVENT_OPTIONS } from '@/types';
import { analyzeTracker } from '@/parsers/tracker';
import { normalizeUrl, getRenamedName } from '@/lib/utils';
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

interface FindReplaceItem {
  id: number | string;
  name: string;
}

interface FindReplaceModalProps {
  visible: boolean;
  onClose: () => void;
  /** All selected items with their current names */
  items: FindReplaceItem[];
  onApply: (find: string, replace: string) => void;
}

export function FindReplaceModal({ visible, onClose, items, onApply }: FindReplaceModalProps) {
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

  // Compute matches live
  const matches = find
    ? items.filter((item) => item.name.includes(find))
    : [];

  const previewItems = find
    ? matches.slice(0, 8).map((item) => ({
        name: item.name,
        result: item.name.split(find).join(replace),
        parts: highlightMatch(item.name, find),
      }))
    : [];

  const handleApply = () => {
    if (!find || matches.length === 0) return;
    onApply(find, replace);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title="Find & Replace"
      maxWidth="520px"
      footer={
        <div className={styles.footerRow}>
          <span className={styles.matchCount}>
            {find ? (
              matches.length > 0
                ? `${matches.length} de ${items.length} serão alterados`
                : 'Nenhum match encontrado'
            ) : ''}
          </span>
          <button className={styles.btnCancel} onClick={onClose}>Cancelar</button>
          <button
            className={styles.btnPrimary}
            disabled={!find || matches.length === 0}
            onClick={handleApply}
          >
            Substituir {matches.length > 0 ? `(${matches.length})` : ''}
          </button>
        </div>
      }
    >
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

      <div className={styles.field}>
        <label className={styles.label}>Substituir por</label>
        <input
          className={styles.input}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          placeholder="Texto novo... (vazio = remover)"
          onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
        />
      </div>

      <div className={styles.preview}>
        {!find ? (
          <span className={styles.previewEmpty}>Digite um termo pra ver o preview das substituições</span>
        ) : matches.length === 0 ? (
          <span className={styles.previewEmpty}>Nenhum item contém &ldquo;{find}&rdquo;</span>
        ) : (
          <>
            {previewItems.map((p, i) => (
              <div key={i} className={styles.previewItem}>
                <span className={styles.previewOld}>
                  {p.parts.map((part, pi) => (
                    <span key={pi} className={part.match ? styles.previewHighlight : undefined}>{part.text}</span>
                  ))}
                </span>
                <span className={styles.previewArrow}>→</span>
                <span className={styles.previewNew}>{p.result}</span>
              </div>
            ))}
            {matches.length > 8 && (
              <div className={styles.previewMore}>...e mais {matches.length - 8}</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Split text into segments, marking which parts match the search term */
function highlightMatch(text: string, term: string): Array<{ text: string; match: boolean }> {
  if (!term) return [{ text, match: false }];
  const parts: Array<{ text: string; match: boolean }> = [];
  let remaining = text;
  while (remaining.length > 0) {
    const idx = remaining.indexOf(term);
    if (idx === -1) {
      parts.push({ text: remaining, match: false });
      break;
    }
    if (idx > 0) parts.push({ text: remaining.slice(0, idx), match: false });
    parts.push({ text: term, match: true });
    remaining = remaining.slice(idx + term.length);
  }
  return parts;
}

/* ══════════════════════════════════════════════
   2b. Bulk Landing Page Modal
   ══════════════════════════════════════════════ */

interface BulkLandingModalProps {
  visible: boolean;
  onClose: () => void;
  count: number;
  onApply: (url: string) => void;
}

export function BulkLandingModal({ visible, onClose, count, onApply }: BulkLandingModalProps) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setUrl('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const handleApply = () => {
    if (!url.trim()) return;
    onApply(normalizeUrl(url));
    onClose();
  };

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={`Landing Page para ${count} item(ns)`}
      maxWidth="480px"
      footer={
        <div className={styles.footerRow}>
          <button className={styles.btnCancel} onClick={onClose}>Cancelar</button>
          <button className={styles.btnPrimary} disabled={!url.trim()} onClick={handleApply}>Aplicar</button>
        </div>
      }
    >
      <div className={styles.field}>
        <label className={styles.label}>URL da landing page</label>
        <input
          ref={inputRef}
          className={styles.input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.marca.com.br/campanha"
          onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
        />
        {url.trim() && !/^https?:\/\//i.test(url.trim()) && url.includes('.') && (
          <div className={styles.urlHint}>
            Será salvo como: <strong>https://{url.trim()}</strong>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════
   3. Bulk Tracker Modal (with DSP scope + VAST event type)
   ══════════════════════════════════════════════ */

type TrackerScope = 'all' | DspType[];

interface BulkTrackerModalProps {
  visible: boolean;
  onClose: () => void;
  count: number;
  availableDsps?: DspType[];
  hasVideo?: boolean; // true if any selected item is video
  hasDisplay?: boolean; // true if any selected item is display/html5
  onApply: (url: string, format: TrackerFormat, scope: TrackerScope, eventType?: VastEventType) => void;
}

const ALL_DSPS: DspType[] = ['xandr', 'dv360', 'stackadapt', 'amazondsp'];

export function BulkTrackerModal({ visible, onClose, count, availableDsps, hasVideo, hasDisplay, onApply }: BulkTrackerModalProps) {
  const [raw, setRaw] = useState('');
  const [scope, setScope] = useState<'all' | DspType[]>('all');
  const [eventType, setEventType] = useState<VastEventType>('impression');
  const inputRef = useRef<HTMLInputElement>(null);

  const dsps = availableDsps || ALL_DSPS;

  useEffect(() => {
    if (visible) {
      setRaw('');
      setScope('all');
      setEventType('impression');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const toggleScope = useCallback((dsp: DspType | 'all') => {
    if (dsp === 'all') {
      setScope('all');
      return;
    }
    setScope((prev) => {
      if (prev === 'all') return [dsp];
      const arr = [...prev];
      const idx = arr.indexOf(dsp);
      if (idx >= 0) {
        arr.splice(idx, 1);
        return arr.length === 0 ? 'all' : arr;
      }
      arr.push(dsp);
      if (arr.length === dsps.length) return 'all';
      return arr;
    });
  }, [dsps.length]);

  const handleApply = () => {
    if (!raw.trim()) return;
    const analyzed = analyzeTracker(raw);
    const url = normalizeUrl(analyzed.url);
    const videoEventsInScope = scope === 'all' || (Array.isArray(scope) && (scope.includes('xandr') || scope.includes('dv360')));
    onApply(url, analyzed.format, scope, hasVideo && videoEventsInScope ? eventType : undefined);
    onClose();
  };

  // Warn if URL doesn't look like a tracking pixel
  const trackerWarning = (() => {
    const v = raw.trim();
    if (!v || v.startsWith('<')) return null; // HTML tags are fine, validated elsewhere
    const clean = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    // Generic domain with no path (e.g. "jenifer.com", "amora.com")
    if (/^[^/]+\.[a-z]{2,}$/i.test(clean)) {
      return 'Essa URL parece um domínio genérico, não um pixel de tracking. Pixels normalmente têm um path (ex: dominio.com/track/pixel.gif)';
    }
    return null;
  })();

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
        {trackerWarning && (
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning)', marginTop: 6, lineHeight: 1.5 }}>
            ⚠ {trackerWarning}
          </div>
        )}
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

      {hasVideo && (scope === 'all' || (Array.isArray(scope) && (scope.includes('xandr') || scope.includes('dv360')))) && (
        <div className={styles.field}>
          <label className={styles.label}>
            Tipo de evento<span className={styles.hint}>(contabilização para vídeo)</span>
          </label>
          <div className={styles.eventGrid}>
            {VAST_EVENT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`${styles.eventBtn} ${eventType === opt.value ? styles.eventBtnActive : ''}`}
                onClick={() => setEventType(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {hasDisplay && eventType !== 'impression' && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', marginTop: 8, lineHeight: 1.5 }}>
              Assets display receberão este tracker como impression. O evento <strong style={{ color: 'var(--accent)' }}>{eventType}</strong> será aplicado apenas nos vídeos.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}