import { useCallback, useState, useRef } from 'react';
import { useWizardStore } from '@/stores/wizard';
import { useUIStore } from '@/stores/ui';
import { UploadZone } from '@/components/shared/UploadZone';
import { FilterBar } from '@/components/shared/FilterBar';
import { BulkBar } from '@/components/shared/BulkBar';
import { StepNav } from '@/components/shared/StepNav';
import { RenameModal, FindReplaceModal, BulkTrackerModal } from '@/components/shared/BulkModals';
import { parseCM360 } from '@/parsers/cm360';
import { parseGenericTags } from '@/parsers/generic';
import { analyzeTracker } from '@/parsers/tracker';
import { normalizeUrl } from '@/lib/utils';
import type { Placement, Tracker } from '@/types';
import { DSP_SHORT_LABELS } from '@/types';
import styles from './StepTags.module.css';

export function StepTags() {
  const {
    parsedData, setParsedData, mergeParsedData,
    selectedTagIds, toggleTagSelection, selectAllTags, clearTagSelection,
    removeTagPlacements, updatePlacement,
    addPlacementTracker, removePlacementTracker,
    tagsFilterType, tagsFilterSize, tagsFilterText, setTagsFilter,
    currentStep, setStep, hasContent, hasDsp,
    setConfig,
  } = useWizardStore();
  const config = useWizardStore((s) => s.getStepConfig());
  const toast = useUIStore((s) => s.toast);

  // Track whether a file was uploaded (separate from manual tags)
  const [fileUploaded, setFileUploaded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── Manual tag form state ──
  const [mtName, setMtName] = useState('');
  const [mtWidth, setMtWidth] = useState('');
  const [mtHeight, setMtHeight] = useState('');
  const [mtType, setMtType] = useState<'display' | 'video'>('display');
  const [mtCode, setMtCode] = useState('');
  const [mtClick, setMtClick] = useState('');
  const mtCodeRef = useRef<HTMLTextAreaElement>(null);
  const [mtErrors, setMtErrors] = useState<Record<string, boolean>>({});

  // ── Auto-detect dimensions + click URL from tag content ──
  const autoDetectFromTag = useCallback((tag: string) => {
    if (!tag) return;
    // Auto-detect dimensions
    let w = 0, h = 0;
    const dw = tag.match(/data-width\s*=\s*"(\d+)"/i);
    const dh = tag.match(/data-height\s*=\s*"(\d+)"/i);
    if (dw && dh) { w = parseInt(dw[1]); h = parseInt(dh[1]); }
    if (!w || !h) { const wm = tag.match(/width\s*[:=]\s*"?(\d+)/i); const hm = tag.match(/height\s*[:=]\s*"?(\d+)/i); if (wm && hm) { w = parseInt(wm[1]); h = parseInt(hm[1]); } }
    if (!w || !h) { const dm = tag.match(/(\d{2,4})x(\d{2,4})/i); if (dm) { w = parseInt(dm[1]); h = parseInt(dm[2]); } }
    if (w && !mtWidth) setMtWidth(String(w));
    if (h && !mtHeight) setMtHeight(String(h));
    // Auto-detect click URL
    if (!mtClick) {
      const ctaMatch = tag.match(/data-cta-url\s*=\s*"([^"]+)"/i);
      if (ctaMatch) setMtClick(ctaMatch[1]);
      else { const hrefMatch = tag.match(/(?:href|url|landing)\s*=\s*"(https?:\/\/[^"]+)"/i); if (hrefMatch) setMtClick(hrefMatch[1]); }
    }
  }, [mtWidth, mtHeight, mtClick]);

  // ── Add manual tag ──
  const handleAddManualTag = useCallback(() => {
    const tag = mtCode.trim();
    if (!tag) { setMtErrors({ code: true }); toast('Cole a tag HTML/JS/VAST no campo', 'error'); mtCodeRef.current?.focus(); return; }
    let w = parseInt(mtWidth) || 0;
    let h = parseInt(mtHeight) || 0;
    if (!w || !h) {
      // Try one more auto-detect
      const dw = tag.match(/data-width\s*=\s*"(\d+)"/i); const dh = tag.match(/data-height\s*=\s*"(\d+)"/i);
      if (dw && dh) { w = parseInt(dw[1]); h = parseInt(dh[1]); }
      if (!w || !h) { const wm = tag.match(/width\s*[:=]\s*"?(\d+)/i); const hm = tag.match(/height\s*[:=]\s*"?(\d+)/i); if (wm && hm) { w = parseInt(wm[1]); h = parseInt(hm[1]); } }
      if (!w || !h) { const dm = tag.match(/(\d{2,4})x(\d{2,4})/i); if (dm) { w = parseInt(dm[1]); h = parseInt(dm[2]); } }
      if (w) setMtWidth(String(w));
      if (h) setMtHeight(String(h));
    }
    if (!w || !h) { setMtErrors({ width: !w, height: !h }); toast('Informe a largura e altura do criativo', 'error'); return; }
    setMtErrors({});
    const dims = w + 'x' + h;
    let clickUrl = mtClick.trim();
    if (!clickUrl) {
      const ctaMatch = tag.match(/data-cta-url\s*=\s*"([^"]+)"/i);
      if (ctaMatch) clickUrl = ctaMatch[1];
      else { const hrefMatch = tag.match(/(?:href|url|landing)\s*=\s*"(https?:\/\/[^"]+)"/i); if (hrefMatch) clickUrl = hrefMatch[1]; }
    }
    let name = mtName.trim();
    if (!name) {
      const srcMatch = tag.match(/data-iframe-src\s*=\s*"([^"]+)"/i) || tag.match(/src\s*=\s*"([^"]+)"/i);
      if (srcMatch) { try { const u = new URL(srcMatch[1]); name = u.pathname.split('/').filter(Boolean).pop() || 'manual_tag'; } catch { name = 'manual_tag'; } }
      else name = 'manual_tag';
      name = name + '_' + dims;
    }
    const isVideo = mtType === 'video';
    const placement: Placement = {
      placementId: 'manual_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      placementName: name,
      dimensions: dims,
      jsTag: isVideo ? '' : tag,
      clickUrl: clickUrl,
      type: mtType,
      vastTag: isVideo ? tag : '',
      trackers: [],
    };
    // Initialize parsedData if needed, then merge
    if (!parsedData || !parsedData.placements.length) {
      setParsedData({ campaignName: 'Manual Tags', advertiserName: '', brandName: '', placements: [placement], contentType: isVideo ? 'video' : 'display' });
    } else {
      const updated = { ...parsedData, placements: [...parsedData.placements, placement] };
      const hasV = updated.placements.some(p => p.type === 'video');
      const hasD = updated.placements.some(p => p.type === 'display');
      updated.contentType = hasV && hasD ? 'mixed' : hasV ? 'video' : 'display';
      setParsedData(updated);
    }
    toast(`${name} adicionado`, 'success');
    setMtCode(''); setMtName(''); setMtClick(''); setMtWidth(''); setMtHeight('');
  }, [mtCode, mtName, mtWidth, mtHeight, mtType, mtClick, parsedData, setParsedData, toast]);

  // ── Per-tag tracker commit ──
  const handleTrackerCommit = useCallback((idx: number, raw: string) => {
    if (!raw.trim()) return;
    const analyzed = analyzeTracker(raw);
    const url = normalizeUrl(analyzed.url);
    const placement = parsedData?.placements[idx];
    if (placement && !placement.trackers.some((t: Tracker) => t.url === url)) {
      addPlacementTracker(idx, { url, format: analyzed.format, dsps: 'all' });
    }
  }, [parsedData, addPlacementTracker]);

  // ── File handling ──
  const handleFiles = useCallback((files: File[]) => {
    const file = files[0];
    if (!file) return;
    setUploadError(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const XLSX = window.XLSX;
        if (!XLSX) { setUploadError('SheetJS não carregado'); toast('SheetJS não carregado', 'error'); return; }

        const wb = XLSX.read(new Uint8Array(e.target!.result as ArrayBuffer), { type: 'array' });
        const sheetName = wb.SheetNames.includes('Tags') ? 'Tags' : wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][];

        // Try CM360 first, then generic
        let result = parseCM360(rows);
        let source = 'CM360';

        if (!result) {
          result = parseGenericTags(rows);
          source = result?.sourceFormat || 'generic';
        }

        if (!result) {
          const msg = 'Formato não reconhecido. Esperado: CM360, DV360 bulk, ou planilha com "Creative name" + "Third-party tag".';
          setUploadError(msg);
          toast(msg, 'error');
          return;
        }

        // Merge with existing data
        setUploadError(null);
        if (parsedData?.placements?.length) {
          const { added, skipped } = mergeParsedData(result);
          setFileUploaded(true);
          toast(
            `${added} novo${added !== 1 ? 's' : ''} adicionado${added !== 1 ? 's' : ''}` +
            (skipped > 0 ? `, ${skipped} já existente${skipped !== 1 ? 's' : ''}` : '') +
            ` (total: ${(parsedData.placements.length + added)})`,
            'success'
          );
        } else {
          setParsedData(result);
          setFileUploaded(true);
          if (result.brandName) {
            setConfig({ brand: result.brandName });
          }
          toast(`${result.placements.length} placements extraídos (${source})`, 'success');
        }
      } catch (err) {
        console.error(err);
        const msg = 'Erro: ' + (err as Error).message;
        setUploadError(msg);
        toast(msg, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }, [parsedData, setParsedData, mergeParsedData, setConfig, toast]);

  // ── Filtering ──
  const allPlacements = parsedData?.placements || [];
  const sizes = [...new Set(allPlacements.map((p) => p.dimensions))].sort((a, b) => {
    const [aw] = a.split('x').map(Number);
    const [bw] = b.split('x').map(Number);
    return bw - aw;
  });

  let filtered = allPlacements.map((p, i) => ({ p, i }));
  if (tagsFilterText) filtered = filtered.filter(({ p }) => p.placementName.toLowerCase().includes(tagsFilterText.toLowerCase()));
  if (tagsFilterType !== 'all') filtered = filtered.filter(({ p }) => p.type === tagsFilterType);
  if (tagsFilterSize !== 'all') filtered = filtered.filter(({ p }) => p.dimensions === tagsFilterSize);

  const hasFilter = tagsFilterText || tagsFilterType !== 'all' || tagsFilterSize !== 'all';

  // ── Navigation ──
  const prevLabel = currentStep > 0 ? config.labels[currentStep - 1] : null;
  const nextLabel = currentStep < config.steps.length - 1 ? config.labels[currentStep + 1] : null;
  const nextStep = config.steps[currentStep + 1];
  const nextDisabled =
    (nextStep === 'dsps' && !hasContent()) ||
    (nextStep === 'config' && (!hasContent() || !hasDsp())) ||
    (nextStep === 'activate' && (!hasContent() || !hasDsp()));
  const nextHint = !hasContent() ? 'Adicione placements primeiro' : !hasDsp() ? 'Selecione ao menos uma DSP' : undefined;

  // ── Modal state ──
  const [renameOpen, setRenameOpen] = useState(false);
  const [frOpen, setFrOpen] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);

  // ── Bulk actions ──
  const selectedCount = selectedTagIds.size;
  const bulkActions = [
    { label: '+ Tracker', onClick: () => setTrackerOpen(true) },
    { label: 'Renomear', onClick: () => setRenameOpen(true) },
    { label: 'Find & Replace', onClick: () => setFrOpen(true) },
    { label: 'Remover', onClick: () => {
      const ids = [...selectedTagIds];
      if (confirm(`Remover ${ids.length} placement(s)?`)) {
        removeTagPlacements(ids);
        toast(`${ids.length} placement(s) removido(s)`, 'success');
      }
    }, danger: true },
  ];

  return (
    <div>
      <div className={styles.header}>
        <h2>Embeds & Adserver Tags</h2>
        <p>Arraste o arquivo de tags exportado do Campaign Manager (.xlsx ou .csv)</p>
      </div>

      <UploadZone
        accept=".xlsx,.xls,.csv"
        icon="📄"
        formatHint=".xlsx .csv"
        hasFiles={fileUploaded}
        fileSummary={fileUploaded && parsedData ? (
          <span><strong>{allPlacements.length}</strong> placements · {parsedData.campaignName || parsedData.advertiserName}</span>
        ) : undefined}
        errorMessage={uploadError}
        onFiles={handleFiles}
        onClear={() => { setParsedData(null); setFileUploaded(false); setUploadError(null); }}
        onClearError={() => setUploadError(null)}
      />

      {/* Manual tag input */}
      <div className={styles.manualDivider}><span>ou adicione tags manualmente</span></div>
      <div className={styles.manualSection}>
        <div className={styles.manualFields}>
          <div className={styles.manualField} style={{ flex: 1 }}>
            <label>Nome do placement</label>
            <input value={mtName} onChange={(e) => setMtName(e.target.value)} placeholder="Ex: LeroyMerlin_GIF_300x250" />
          </div>
          <div className={styles.manualField} style={{ width: 90 }}>
            <label>Largura</label>
            <input className={mtErrors.width ? styles.inputError : ''} type="number" value={mtWidth} onChange={(e) => { setMtWidth(e.target.value); setMtErrors((p) => ({ ...p, width: false })); }} placeholder="300" />
          </div>
          <div className={styles.manualField} style={{ width: 90 }}>
            <label>Altura</label>
            <input className={mtErrors.height ? styles.inputError : ''} type="number" value={mtHeight} onChange={(e) => { setMtHeight(e.target.value); setMtErrors((p) => ({ ...p, height: false })); }} placeholder="250" />
          </div>
          <div className={styles.manualField} style={{ width: 110 }}>
            <label>Tipo</label>
            <select value={mtType} onChange={(e) => setMtType(e.target.value as 'display' | 'video')}>
              <option value="display">Display</option>
              <option value="video">Video</option>
            </select>
          </div>
        </div>
        <div className={styles.manualField} style={{ width: '100%', marginBottom: 12 }}>
          <label>Tag HTML / JS / VAST URL</label>
          <textarea
            className={mtErrors.code ? styles.inputError : ''}
            ref={mtCodeRef}
            value={mtCode}
            onChange={(e) => { setMtCode(e.target.value); setMtErrors((p) => ({ ...p, code: false })); autoDetectFromTag(e.target.value); }}
            rows={3}
            placeholder="Cole a tag completa aqui (HTML, JS tag, ou VAST URL)"
          />
        </div>
        <div className={styles.manualField} style={{ width: '100%', marginBottom: 12 }}>
          <label>Click URL <span style={{ fontWeight: 400, color: 'var(--text-tri)' }}>(opcional)</span></label>
          <input value={mtClick} onChange={(e) => setMtClick(e.target.value)} placeholder="https://..." />
        </div>
        <button className={styles.manualAddBtn} onClick={handleAddManualTag}>Adicionar Tag</button>
      </div>

      {/* Extracted info — only for file uploads */}
      {fileUploaded && parsedData && (
        <div className={styles.extractedInfo}>
          <h3 className={styles.extractedTitle}>Dados extraídos</h3>
          <div className={styles.infoGrid}>
            <div className={styles.infoItem}>
              <div className={styles.infoLabel}>Advertiser</div>
              <div className={styles.infoValue}>{parsedData.advertiserName || '-'}</div>
            </div>
            <div className={styles.infoItem}>
              <div className={styles.infoLabel}>Campaign</div>
              <div className={styles.infoValue}>{parsedData.campaignName || '-'}</div>
            </div>
            <div className={styles.infoItem}>
              <div className={styles.infoLabel}>Marca</div>
              <div className={styles.infoValue} style={{ color: 'var(--accent)' }}>{parsedData.brandName || '-'}</div>
            </div>
            <div className={styles.infoItem}>
              <div className={styles.infoLabel}>Placements</div>
              <div className={`${styles.infoValue} ${styles.mono}`}>
                {allPlacements.length} creatives · {parsedData.contentType === 'mixed' ? 'Display + Video' : parsedData.contentType === 'video' ? 'Video' : 'Display'}
                {parsedData.sourceFormat ? ` · ${parsedData.sourceFormat}` : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Placements table */}
      {allPlacements.length > 0 && (
        <div className={styles.tableSection}>
          <BulkBar count={selectedCount} actions={bulkActions} onCancel={clearTagSelection} />

          <FilterBar
            searchValue={tagsFilterText}
            onSearchChange={(v) => setTagsFilter({ text: v })}
            searchPlaceholder="Filtrar por nome..."
            pills={{
              options: [
                { value: 'all', label: 'Todos' },
                { value: 'display', label: 'Display' },
                { value: 'video', label: 'Video' },
              ],
              active: tagsFilterType,
              onChange: (v) => setTagsFilter({ type: v as 'all' | 'display' | 'video' }),
            }}
            sizeOptions={sizes}
            sizeValue={tagsFilterSize}
            onSizeChange={(v) => setTagsFilter({ size: v })}
            countText={hasFilter ? `${filtered.length}/${allPlacements.length}` : ''}
            onSelectFiltered={tagsFilterText ? () => {
              selectAllTags(filtered.map(({ i }) => i));
              toast(`${filtered.length} placement(s) selecionado(s)`, 'success');
            } : undefined}
            showClear={!!hasFilter}
            onClear={() => setTagsFilter({ type: 'all', size: 'all', text: '' })}
          />

          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="Lista de placements">
              <thead>
                <tr>
                  <th className={styles.cbCol}>
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every(({ i }) => selectedTagIds.has(i))}
                      onChange={(e) => {
                        if (e.target.checked) selectAllTags(filtered.map(({ i }) => i));
                        else clearTagSelection();
                      }}
                      aria-label="Selecionar todos"
                    />
                  </th>
                  <th>Placement Name</th>
                  <th>Tipo</th>
                  <th>Size</th>
                  <th>Tag</th>
                  <th>Click URL</th>
                  <th>Tracker</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ p, i }, rowIdx) => (
                  <tr key={p.placementId + i} style={{ animationDelay: `${rowIdx * 30}ms` }}>
                    <td className={styles.cbCol}>
                      <input
                        type="checkbox"
                        checked={selectedTagIds.has(i)}
                        onChange={() => toggleTagSelection(i)}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.cellInput}
                        value={p.placementName}
                        onChange={(e) => updatePlacement(i, 'placementName', e.target.value)}
                        title={p.placementName}
                        onFocus={(e) => (e.target as HTMLInputElement).dataset.prev = p.placementName}
                        onBlur={(e) => {
                          if (e.target.dataset.prev && e.target.dataset.prev !== p.placementName) {
                            e.target.classList.remove(styles.flash);
                            void e.target.offsetWidth;
                            e.target.classList.add(styles.flash);
                          }
                        }}
                      />
                    </td>
                    <td>
                      <span className={`${styles.typeBadge} ${styles[p.type]}`}>{p.type}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
                      {p.dimensions}
                    </td>
                    <td className={styles.tagCell}>
                      <span className={styles.tagPreview} title={p.jsTag || p.vastTag}>
                        {(p.jsTag || p.vastTag || '').substring(0, 60)}{(p.jsTag || p.vastTag || '').length > 60 ? '…' : ''}
                      </span>
                    </td>
                    <td>
                      <input
                        className={`${styles.cellInput} ${styles.mono}`}
                        value={p.clickUrl}
                        onChange={(e) => updatePlacement(i, 'clickUrl', e.target.value)}
                        placeholder="https://..."
                      />
                    </td>
                    <td className={styles.trackerCell}>
                      <div className={styles.trackerChips}>
                        {p.trackers.map((t: Tracker, ti: number) => (
                          <span key={ti} className={styles.trackerChip}>
                            <span className={styles.trackerScope}>
                              {t.dsps === 'all' ? 'ALL' : (Array.isArray(t.dsps) ? t.dsps.map(d => DSP_SHORT_LABELS[d] || d).join(' ') : 'ALL')}
                            </span>
                            <span className={styles.trackerUrl} title={t.url}>{t.url}</span>
                            <button className={styles.trackerRm} onClick={() => removePlacementTracker(i, ti)}>✕</button>
                          </span>
                        ))}
                        <input
                          className={styles.trackerInput}
                          placeholder="+ pixel"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleTrackerCommit(i, (e.target as HTMLInputElement).value);
                              (e.target as HTMLInputElement).value = '';
                            }
                          }}
                          onBlur={(e) => {
                            handleTrackerCommit(i, e.target.value);
                            e.target.value = '';
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      <button
                        className={styles.removeBtn}
                        onClick={() => {
                          const snapshot = { ...p, trackers: [...p.trackers] };
                          const placementName = p.placementName;
                          removeTagPlacements([i]);
                          toast(`Removido: ${placementName}`, '', () => {
                            // Re-add placement via mergeParsedData
                            if (parsedData) {
                              const restored = {
                                ...parsedData,
                                placements: [...parsedData.placements, snapshot],
                              };
                              setParsedData(restored);
                            }
                          });
                        }}
                        title="Remover"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <StepNav
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        nextDisabled={nextDisabled}
        nextDisabledHint={nextHint}
        onPrev={currentStep > 0 ? () => setStep(currentStep - 1) : undefined}
        onNext={currentStep < config.steps.length - 1 ? () => setStep(currentStep + 1) : undefined}
      />

      {/* ── Bulk Modals ── */}
      <RenameModal
        visible={renameOpen}
        onClose={() => setRenameOpen(false)}
        items={[...selectedTagIds].map((idx) => {
          const p = parsedData?.placements[idx];
          return p ? { id: idx, name: p.placementName, dimensions: p.dimensions, type: p.type } : null;
        }).filter(Boolean) as Array<{ id: number | string; name: string; dimensions?: string; type?: string }>}
        onApply={(getNewName) => {
          const ids = [...selectedTagIds];
          let count = 0;
          ids.forEach((idx, i) => {
            const p = parsedData?.placements[idx];
            if (p) {
              const item = { id: idx, name: p.placementName, dimensions: p.dimensions, type: p.type };
              updatePlacement(idx, 'placementName', getNewName(item, i));
              count++;
            }
          });
          toast(`${count} nome(s) alterado(s)`, 'success');
        }}
      />

      <FindReplaceModal
        visible={frOpen}
        onClose={() => setFrOpen(false)}
        count={selectedTagIds.size}
        onApply={(find, replace) => {
          let count = 0;
          selectedTagIds.forEach((idx) => {
            const p = parsedData?.placements[idx];
            if (p && p.placementName.includes(find)) {
              updatePlacement(idx, 'placementName', p.placementName.split(find).join(replace));
              count++;
            }
          });
          toast(`${count} nome(s) atualizado(s)`, count ? 'success' : '');
        }}
      />

      <BulkTrackerModal
        visible={trackerOpen}
        onClose={() => setTrackerOpen(false)}
        count={selectedTagIds.size}
        availableDsps={['xandr', 'dv360', 'stackadapt', 'amazondsp']}
        onApply={(url, format, scope) => {
          selectedTagIds.forEach((idx) => {
            addPlacementTracker(idx, { url, format, dsps: scope });
          });
          toast(`Tracker aplicado em ${selectedTagIds.size} placement(s)`, 'success');
        }}
      />
    </div>
  );
}
