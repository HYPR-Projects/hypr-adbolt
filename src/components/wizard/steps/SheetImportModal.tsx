import { useState, useCallback, useRef } from 'react';
import { Modal } from '@/components/shared/Modal';
import { requireCdnLib } from '@/lib/cdn-loader';
import { parseAssetSheet, type AssetSheetRow } from '@/parsers/asset-sheet';
import { matchAssets, type MatchResult, type MatchAsset } from '@/lib/asset-sheet-match';
import type { AssetEntry } from '@/types';
import styles from './SheetImportModal.module.css';

interface Props {
  visible: boolean;
  onClose: () => void;
  assets: AssetEntry[];
  onApply: (assignments: Array<{ assetId: number; row: AssetSheetRow }>) => void;
}

type XLSX = Window['XLSX'];

const rowLabel = (r: AssetSheetRow) => {
  const tail = r.name.includes('|') ? r.name.split('|').slice(-2).join('|') : r.name;
  return r.placementId ? `${r.placementId} · ${tail}` : tail;
};

export function SheetImportModal({ visible, onClose, assets, onApply }: Props) {
  const [result, setResult] = useState<MatchResult | null>(null);
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setResult(null); setPicks({}); setError(''); setFileName('');
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const handleClose = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true); setError('');
    try {
      const XLSX = await requireCdnLib<XLSX>('XLSX');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][];
      const parsed = parseAssetSheet(rows);
      if (!parsed.rows.length) {
        setError(parsed.warnings.join(' ') || 'Não encontrei linhas de criativo na planilha.');
        setBusy(false);
        return;
      }
      const matchAssetsInput: MatchAsset[] = assets.map((a) => ({
        id: a.id, name: a.name, dimensions: a.dimensions, type: a.type, thumb: a.thumb,
      }));
      const res = matchAssets(matchAssetsInput, parsed.rows);
      // preselect suggested candidate for each ambiguity
      const initialPicks: Record<number, number> = {};
      res.ambiguous.forEach((amb) => { initialPicks[amb.assetId] = amb.suggestedIdx; });
      setPicks(initialPicks);
      setResult(res);
      setFileName(file.name);
    } catch (e) {
      setError((e as Error).message || 'Falha ao ler a planilha.');
    } finally {
      setBusy(false);
    }
  }, [assets]);

  const apply = useCallback(() => {
    if (!result) return;
    const assignments: Array<{ assetId: number; row: AssetSheetRow }> = [
      ...result.matched.map((m) => ({ assetId: m.assetId, row: m.row })),
      ...result.ambiguous.map((amb) => ({
        assetId: amb.assetId,
        row: amb.candidates[picks[amb.assetId] ?? amb.suggestedIdx],
      })),
    ];
    onApply(assignments);
    handleClose();
  }, [result, picks, onApply, handleClose]);

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const mismatches = result?.matched.filter((m) => m.sizeMismatch).length ?? 0;
  const total = result ? result.matched.length + result.ambiguous.length : 0;

  const footer = result ? (
    <>
      <button className={styles.btnGhost} onClick={reset}>Trocar planilha</button>
      <button className={styles.btnPrimary} onClick={apply} disabled={total === 0}>
        Aplicar em {total} asset{total === 1 ? '' : 's'}
      </button>
    </>
  ) : undefined;

  return (
    <Modal visible={visible} onClose={handleClose} title="Importar planilha" maxWidth="640px" footer={footer}>
      {!result && (
        <div className={styles.drop}>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className={styles.fileInput}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          <div className={styles.dropInner} onClick={() => inputRef.current?.click()}>
            <span className={styles.dropIcon}>📊</span>
            <span className={styles.dropTitle}>{busy ? 'Lendo planilha...' : 'Selecione a planilha (.xlsx)'}</span>
            <span className={styles.dropHint}>
              Casa por <strong>código</strong> do criativo e <strong>dimensão</strong>. Preenche nome,
              landing (track click) e trackers (track impre + DoubleVerify como impressão).
            </span>
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </div>
      )}

      {result && (
        <div className={styles.summary}>
          <div className={styles.statRow}>
            <span className={styles.statOk}>✓ {result.matched.length} automático(s)</span>
            {result.ambiguous.length > 0 && <span className={styles.statWarn}>⚠ {result.ambiguous.length} pra decidir</span>}
            {result.unmatchedAssets.length > 0 && <span className={styles.statMuted}>✗ {result.unmatchedAssets.length} sem linha</span>}
            {result.unmatchedRows.length > 0 && <span className={styles.statMuted}>{result.unmatchedRows.length} linha(s) sem asset</span>}
          </div>
          <div className={styles.fileTag}>{fileName}</div>

          {mismatches > 0 && (
            <div className={styles.mismatchWarn}>
              ⚠ {mismatches} criativo(s) com código batendo mas dimensão divergente — confira antes de ativar.
            </div>
          )}

          {/* Ambiguities first — they need a decision */}
          {result.ambiguous.map((amb) => {
            const a = assetById.get(amb.assetId);
            return (
              <div key={amb.assetId} className={styles.ambBlock}>
                <div className={styles.ambHead}>
                  {a?.thumb && <img src={a.thumb} className={styles.thumb} alt="" />}
                  <div>
                    <div className={styles.ambName}>{a?.name}</div>
                    <div className={styles.ambSub}>{a?.dimensions} · escolha a linha:</div>
                  </div>
                </div>
                <div className={styles.candidates}>
                  {amb.candidates.map((c, idx) => (
                    <label key={idx} className={styles.candidate}>
                      <input
                        type="radio"
                        name={`amb-${amb.assetId}`}
                        checked={(picks[amb.assetId] ?? amb.suggestedIdx) === idx}
                        onChange={() => setPicks((p) => ({ ...p, [amb.assetId]: idx }))}
                      />
                      <span className={styles.candidateLabel}>{rowLabel(c)}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Auto-matched, compact */}
          {result.matched.length > 0 && (
            <div className={styles.matchedList}>
              {result.matched.map((m) => {
                const a = assetById.get(m.assetId);
                return (
                  <div key={m.assetId} className={`${styles.matchedRow} ${m.sizeMismatch ? styles.rowMismatch : ''}`}>
                    <span className={styles.mAsset}>{a?.name}</span>
                    <span className={styles.mArrow}>→</span>
                    <span className={styles.mTarget}>{rowLabel(m.row)}</span>
                    <span className={styles.mTag}>{m.reason}</span>
                    {m.sizeMismatch && <span className={styles.mWarn}>size ≠</span>}
                  </div>
                );
              })}
            </div>
          )}

          {result.unmatchedAssets.length > 0 && (
            <div className={styles.muted}>
              Sem linha na planilha: {result.unmatchedAssets.map((a) => a.name).join(', ')}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
