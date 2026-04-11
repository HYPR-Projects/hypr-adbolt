import { useCallback } from 'react';
import { useWizardStore } from '@/stores/wizard';
import { useUIStore } from '@/stores/ui';
import { UploadZone } from '@/components/shared/UploadZone';
import { FilterBar } from '@/components/shared/FilterBar';
import { BulkBar } from '@/components/shared/BulkBar';
import { StepNav } from '@/components/shared/StepNav';
import { parseCM360 } from '@/parsers/cm360';
import { parseGenericTags } from '@/parsers/generic';
import styles from './StepTags.module.css';

export function StepTags() {
  const {
    parsedData, setParsedData, mergeParsedData,
    selectedTagIds, toggleTagSelection, selectAllTags, clearTagSelection,
    removeTagPlacements, updatePlacement,
    tagsFilterType, tagsFilterSize, tagsFilterText, setTagsFilter,
    currentStep, setStep, hasContent, hasDsp,
    setConfig,
  } = useWizardStore();
  const config = useWizardStore((s) => s.getStepConfig());
  const toast = useUIStore((s) => s.toast);

  // ── File handling ──
  const handleFiles = useCallback((files: File[]) => {
    const file = files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const XLSX = window.XLSX;
        if (!XLSX) { toast('SheetJS não carregado', 'error'); return; }

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
          toast('Formato não reconhecido. Esperado: CM360, DV360 bulk, ou planilha com "Creative name" + "Third-party tag".', 'error');
          return;
        }

        // Merge with existing data
        if (parsedData?.placements?.length) {
          const { added, skipped } = mergeParsedData(result);
          toast(
            `${added} novo${added !== 1 ? 's' : ''} adicionado${added !== 1 ? 's' : ''}` +
            (skipped > 0 ? `, ${skipped} já existente${skipped !== 1 ? 's' : ''}` : '') +
            ` (total: ${(parsedData.placements.length + added)})`,
            'success'
          );
        } else {
          setParsedData(result);
          // Auto-fill brand from parsed data (legacy: inputBrand.value = result.brandName)
          if (result.brandName) {
            setConfig({ brand: result.brandName });
          }
          toast(`${result.placements.length} placements extraídos (${source})`, 'success');
        }
      } catch (err) {
        console.error(err);
        toast('Erro: ' + (err as Error).message, 'error');
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

  // ── Bulk actions ──
  const selectedCount = selectedTagIds.size;
  const bulkActions = [
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
        hasFiles={!!parsedData}
        fileSummary={parsedData ? (
          <span><strong>{allPlacements.length}</strong> placements · {parsedData.campaignName || parsedData.advertiserName}</span>
        ) : undefined}
        onFiles={handleFiles}
        onClear={() => setParsedData(null)}
      />

      {/* Extracted info */}
      {parsedData && (
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
                    <td>
                      <button
                        className={styles.removeBtn}
                        onClick={() => {
                          removeTagPlacements([i]);
                          toast(`Removido: ${p.placementName}`, 'success');
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
        onPrev={currentStep > 0 ? () => setStep(currentStep - 1) : undefined}
        onNext={currentStep < config.steps.length - 1 ? () => setStep(currentStep + 1) : undefined}
      />
    </div>
  );
}
