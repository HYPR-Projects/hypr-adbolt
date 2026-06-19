import { useState } from 'react';
import type { LintResult } from '@/lib/adbolt-tag-linter';
import styles from './PreflightPanel.module.css';

export interface PreflightItem {
  idx: number;
  name: string;
  /** Current tag (jsTag for display, vastTag for video) — left side of the diff. */
  original: string;
  result: LintResult;
}

interface Props {
  items: PreflightItem[];
  /** Apply the corrected tag for one placement. */
  onApplyFix: (idx: number) => void;
  /** Apply every available auto-fix. */
  onApplyAll: () => void;
}

// ── Minimal line diff (LCS) for the before/after view ──

type DiffRow = { type: 'ctx' | 'add' | 'del'; text: string };

function lineDiff(a: string, b: string): DiffRow[] {
  const oldL = a.split('\n');
  const newL = b.split('\n');
  const n = oldL.length, m = newL.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldL[i] === newL[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldL[i] === newL[j]) { out.push({ type: 'ctx', text: oldL[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: oldL[i] }); i++; }
    else { out.push({ type: 'add', text: newL[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: oldL[i++] }); }
  while (j < m) { out.push({ type: 'add', text: newL[j++] }); }
  return out;
}

function Diff({ original, corrected }: { original: string; corrected: string }) {
  const rows = lineDiff(original, corrected);
  return (
    <div className={styles.diff}>
      {rows.map((r, k) => (
        <div
          key={k}
          className={`${styles.diffLine} ${r.type === 'add' ? styles.diffAdd : r.type === 'del' ? styles.diffDel : styles.diffCtx}`}
        >
          <span>{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
          {r.text}
        </div>
      ))}
    </div>
  );
}

export function PreflightPanel({ items, onApplyFix, onApplyAll }: Props) {
  const [openDiff, setOpenDiff] = useState<Set<number>>(new Set());
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [cm360Done, setCm360Done] = useState<Set<string>>(new Set());

  const toggleDiff = (idx: number) =>
    setOpenDiff((s) => { const n = new Set(s); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; });

  // Counts for the header.
  let blocked = 0, fixable = 0, avisos = 0, cm360 = 0;
  for (const it of items) {
    if (it.result.status === 'blocked') blocked++;
    if (it.result.tagCorrigida) fixable++;
    avisos += it.result.issues.filter((i) => i.nivel === 'aviso').length;
    cm360 += it.result.flagsCM360.length;
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.headLeft}>
          <span className={styles.title}>Preflight de tags</span>
          <div className={styles.chips}>
            {blocked > 0 && <span className={`${styles.chip} ${styles.chipBlocked}`}>{blocked} bloqueio(s)</span>}
            {fixable > 0 && <span className={`${styles.chip} ${styles.chipFix}`}>{fixable} corrigível(is)</span>}
            {avisos > 0 && <span className={`${styles.chip} ${styles.chipWarn}`}>{avisos} aviso(s)</span>}
            {cm360 > 0 && <span className={`${styles.chip} ${styles.chipExt}`}>{cm360} flag(s) CM360</span>}
          </div>
        </div>
        {fixable > 0 && (
          <button className={styles.applyAll} onClick={onApplyAll}>
            Aplicar {fixable} correção(ões)
          </button>
        )}
      </div>

      <div className={styles.list}>
        {items.map((it) => {
          const { result } = it;
          const dot = result.status === 'blocked' ? styles.dotBlocked : result.tagCorrigida ? styles.dotFix : styles.dotWarn;
          const visibleIssues = result.issues.filter((i) => !ignored.has(it.idx + ':' + i.code));
          return (
            <div className={styles.item} key={it.idx}>
              <div className={styles.itemHead}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span className={`${styles.statusDot} ${dot}`} />
                  <span className={styles.itemName} title={it.name}>{it.name}</span>
                </div>
                <div className={styles.itemActions}>
                  {result.tagCorrigida && (
                    <>
                      <button className={styles.diffToggle} onClick={() => toggleDiff(it.idx)}>
                        {openDiff.has(it.idx) ? 'Ocultar diff' : 'Ver diff'}
                      </button>
                      <button className={styles.fixBtn} onClick={() => onApplyFix(it.idx)}>Corrigir</button>
                    </>
                  )}
                </div>
              </div>

              <div className={styles.issues}>
                {visibleIssues.map((i) => (
                  <div className={styles.issue} key={i.code}>
                    <span className={`${styles.issueBadge} ${i.autofix ? styles.badgeFix : i.nivel === 'bloqueia' ? styles.badgeBlock : styles.badgeWarn}`}>
                      {i.autofix ? 'auto' : i.nivel === 'bloqueia' ? 'bloqueia' : 'aviso'}
                    </span>
                    <span className={styles.issueMsg}>{i.mensagem}</span>
                    {i.nivel === 'aviso' && !i.autofix && (
                      <button
                        className={styles.ignoreBtn}
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setIgnored((s) => new Set(s).add(it.idx + ':' + i.code))}
                      >
                        Ignorar
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {result.tagCorrigida && openDiff.has(it.idx) && (
                <Diff original={it.original} corrected={result.tagCorrigida} />
              )}

              {result.flagsCM360.length > 0 && (
                <div className={styles.cm360}>
                  <div className={styles.cm360Head}>⚠ Resolver com o ad server (CM360) — AdBolt não corrige</div>
                  {result.flagsCM360.map((f) => {
                    const key = it.idx + ':' + f.code;
                    const done = cm360Done.has(key);
                    return (
                      <label className={`${styles.cm360Item} ${done ? styles.done : ''}`} key={f.code}>
                        <input
                          type="checkbox"
                          checked={done}
                          onChange={() => setCm360Done((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
                        />
                        <span>{f.mensagem}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
