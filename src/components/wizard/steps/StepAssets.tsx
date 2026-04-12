import { useCallback, useState, useRef, useEffect } from 'react';
import { useWizardStore } from '@/stores/wizard';
import { useUIStore } from '@/stores/ui';
import { UploadZone } from '@/components/shared/UploadZone';
import { FilterBar } from '@/components/shared/FilterBar';
import { BulkBar } from '@/components/shared/BulkBar';
import { StepNav } from '@/components/shared/StepNav';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { RenameModal, FindReplaceModal, BulkTrackerModal } from '@/components/shared/BulkModals';
import { PreviewThumb, CreativePreviewModal } from '@/components/shared/CreativePreview';
import {
  getAssetType, readFileDimensions, generateThumb,
  isIABSize, getSizeSuggestion, resizeAssetImage, compressImage,
} from '@/lib/asset-processing';
import { extractZipToFiles, processHTML5Zip } from '@/lib/html5-zip';
import { analyzeTracker } from '@/parsers/tracker';
import { normalizeUrl, formatBytes } from '@/lib/utils';
import { ASSET_DSP_LIMITS, DSP_SHORT_LABELS } from '@/types';
import type { AssetEntry } from '@/types';
import styles from './StepAssets.module.css';

export function StepAssets() {
  const store = useWizardStore();
  const {
    assetEntries, addAssetEntries, removeAsset, updateAsset, duplicateAsset,
    selectedAssetIds, toggleAssetSelection, selectAllAssets, clearAssetSelection,
    assetsFilterType, assetsFilterSize, assetsFilterText, setAssetsFilter,
    addAssetTracker, removeAssetTracker, getNextAssetId,
    selectedDsps, currentStep, setStep, hasContent, hasDsp,
  } = store;
  const config = store.getStepConfig();
  const toast = useUIStore((s) => s.toast);

  // ── File handling ──
  const handleFiles = useCallback(async (files: File[]) => {
    const zipFiles: File[] = [];
    const regularFiles: File[] = [];

    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.zip')) zipFiles.push(f);
      else regularFiles.push(f);
    }

    // Process ZIPs
    for (const zf of zipFiles) {
      toast(`Analisando ${zf.name}...`, '');
      try {
        const html5Result = await processHTML5Zip(zf);
        if (html5Result) {
          const entry: AssetEntry = { ...html5Result, id: getNextAssetId() };
          addAssetEntries([entry]);
          const msg = html5Result.html5Warnings?.length
            ? `HTML5 ${html5Result.w}x${html5Result.h} (${html5Result.html5Warnings.join(', ')})`
            : `HTML5 ${html5Result.w}x${html5Result.h}`;
          toast(msg, html5Result.html5Warnings?.length ? '' : 'success');
        } else {
          // Regular ZIP with images/videos
          const extracted = await extractZipToFiles(zf);
          regularFiles.push(...extracted);
        }
      } catch (err) {
        console.error('ZIP processing error:', zf.name, err);
        toast(`Erro ao processar ${zf.name}: ${(err as Error).message}`, 'error');
      }
    }

    // Process regular files
    if (regularFiles.length) {
      const total = regularFiles.length;
      if (total > 3) toast(`Processando 0/${total} arquivos...`, '');

      const newEntries: AssetEntry[] = [];
      for (let i = 0; i < regularFiles.length; i++) {
        const file = regularFiles[i];
        const type = getAssetType(file);
        if (!type) {
          toast(`"${file.name}" não é suportado. Use JPG, PNG, GIF ou MP4.`, 'error');
          continue;
        }
        try {
          const dims = await readFileDimensions(file, type);
          const thumb = await generateThumb(file, type);
          newEntries.push({
            id: getNextAssetId(),
            type,
            file,
            originalFile: file,
            name: file.name.replace(/\.\w+$/, ''),
            dimensions: `${dims.w}x${dims.h}`,
            w: dims.w,
            h: dims.h,
            duration: dims.duration || 0,
            size: file.size,
            thumb,
            landingPage: '',
            trackers: [],
            compressed: false,
            compressedFile: null,
          });
        } catch (err) {
          console.error('File processing error:', file.name, err);
          toast(`Erro ao processar ${file.name}`, 'error');
        }
        if (total > 3 && i < total - 1) toast(`Processando ${i + 1}/${total} arquivos...`, '');
      }

      if (newEntries.length) {
        addAssetEntries(newEntries);
        toast(`${assetEntries.length + newEntries.length} asset(s) carregado(s)`, 'success');
      }
    }

    if (!regularFiles.length && !zipFiles.length) {
      toast('Nenhum arquivo válido encontrado', 'error');
    }
  }, [addAssetEntries, getNextAssetId, assetEntries.length, toast]);

  // ── Filtering ──
  const sizes = [...new Set(assetEntries.map((a) => a.dimensions))].sort((a, b) => {
    const [aw] = a.split('x').map(Number);
    const [bw] = b.split('x').map(Number);
    return bw - aw;
  });

  let filtered = assetEntries;
  if (assetsFilterText) filtered = filtered.filter((a) => a.name.toLowerCase().includes(assetsFilterText.toLowerCase()));
  if (assetsFilterType !== 'all') filtered = filtered.filter((a) => a.type === assetsFilterType);
  if (assetsFilterSize !== 'all') filtered = filtered.filter((a) => a.dimensions === assetsFilterSize);

  const hasFilter = assetsFilterText || assetsFilterType !== 'all' || assetsFilterSize !== 'all';

  // ── Weight class ──
  const getWeightClass = (entry: AssetEntry): string => {
    // When no DSPs selected, use most restrictive limit across all DSPs as preview
    const dspList = selectedDsps.size > 0
      ? [...selectedDsps]
      : Object.keys(ASSET_DSP_LIMITS);
    const maxWeight = Math.min(
      ...dspList.map((d) => (ASSET_DSP_LIMITS[d] || {})[entry.type] || Infinity).filter((v) => v !== Infinity),
      Infinity,
    );
    if (maxWeight === Infinity) return 'ok';
    const sz = entry.compressedFile ? entry.compressedFile.size : entry.size;
    if (sz > maxWeight * 1.5) return 'over';
    if (sz > maxWeight * 0.8) return 'warn';
    return 'ok';
  };

  // ── Tracker commit on blur ──
  const handleTrackerCommit = (assetId: number, raw: string) => {
    if (!raw.trim()) return;
    const analyzed = analyzeTracker(raw);
    const url = normalizeUrl(analyzed.url);
    const entry = assetEntries.find((a) => a.id === assetId);
    if (entry && !entry.trackers.some((t) => t.url === url)) {
      addAssetTracker(assetId, { url, format: analyzed.format, dsps: 'all' });
    }
  };

  // ── Resize handler ──
  const handleResize = async (entry: AssetEntry, suggest: string) => {
    const [nw, nh] = suggest.split('x').map(Number);
    try {
      const result = await resizeAssetImage(entry.originalFile, nw, nh);
      if (result) {
        updateAsset(entry.id, {
          file: result.file,
          compressedFile: result.file,
          size: result.file.size,
          w: nw,
          h: nh,
          dimensions: `${nw}x${nh}`,
          thumb: result.thumb,
          resized: true,
        });
        toast(`${entry.name} redimensionado pra ${suggest}`, 'success');
      }
    } catch (err) {
      console.error('Resize error:', entry.name, err);
      toast('Erro ao redimensionar', 'error');
    }
  };

  // ── Modal state ──
  const [renameOpen, setRenameOpen] = useState(false);
  const [frOpen, setFrOpen] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<AssetEntry | null>(null);

  // Track object URLs for proper cleanup (prevent memory leaks)
  const previewUrlRef = useRef<string | null>(null);

  // Cleanup object URL when preview closes
  useEffect(() => {
    if (!previewAsset && previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, [previewAsset]);

  // ── Preview handler ──
  const openPreview = useCallback((asset: AssetEntry) => {
    // Revoke previous URL before creating new one
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewAsset(asset);
  }, []);

  const getPreviewData = useCallback((a: AssetEntry) => {
    if (!a) return null;
    const base = { name: a.name, dimensions: a.dimensions };
    if (a.type === 'display') {
      // Revoke old URL before creating new
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(a.originalFile);
      previewUrlRef.current = url;
      return { ...base, type: 'display' as const, imageUrl: url, mimeType: a.originalFile.type, thumbUrl: a.thumb };
    }
    if (a.type === 'video') {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(a.originalFile);
      previewUrlRef.current = url;
      return { ...base, type: 'video' as const, videoUrl: url, thumbUrl: a.thumb };
    }
    if (a.type === 'html5' && a.html5Content) {
      return { ...base, type: 'html5' as const, html5Content: a.html5Content, thumbUrl: a.thumb };
    }
    return { ...base, type: 'display' as const, thumbUrl: a.thumb };
  }, []);

  // ── Bulk Compress ──
  const handleBulkCompress = async () => {
    const ids = [...selectedAssetIds];
    const selected = ids.map((id) => assetEntries.find((a) => a.id === id)).filter(Boolean) as AssetEntry[];
    const displayAssets = selected.filter((a) => a.type === 'display');
    const skippedTypes = new Set(selected.filter((a) => a.type !== 'display').map((a) => a.type));

    if (!displayAssets.length) {
      const reasons: string[] = [];
      if (skippedTypes.has('html5')) reasons.push('HTML5 não pode ser comprimido');
      if (skippedTypes.has('video')) reasons.push('vídeo não é comprimível');
      toast(reasons.length ? reasons.join('; ') : 'Selecione assets display pra comprimir', '');
      return;
    }

    const maxBytes = Math.min(
      ...[...selectedDsps].map((d) => (ASSET_DSP_LIMITS[d] || {}).display || Infinity).filter((v) => v !== Infinity),
      400 * 1024, // fallback Xandr
    );

    let compressed = 0;
    for (const a of displayAssets) {
      const result = await compressImage(a.originalFile, maxBytes);
      if (result.compressed) {
        updateAsset(a.id, {
          compressedFile: result.file,
          size: result.file.size,
          compressed: true,
        });
        compressed++;
      }
    }
    toast(compressed ? `${compressed} imagem(ns) comprimida(s)` : 'Todos já estão dentro do limite', compressed ? 'success' : '');
  };

  // ── Bulk Duplicate ──
  const handleBulkDuplicate = () => {
    const ids = [...selectedAssetIds];
    ids.forEach((id) => duplicateAsset(id));
    toast(`${ids.length} asset(s) duplicado(s)`, 'success');
  };

  // ── Bulk actions ──
  const selectedCount = selectedAssetIds.size;
  const bulkActions = [
    {
      label: 'Landing Page', onClick: () => {
        const val = prompt(`Landing Page pra ${selectedCount} asset(s):`);
        if (val === null) return;
        const normalized = normalizeUrl(val);
        selectedAssetIds.forEach((id) => updateAsset(id, { landingPage: normalized }));
        toast(`Landing page aplicada em ${selectedCount} asset(s)`, 'success');
      },
    },
    { label: '+ Tracker', onClick: () => setTrackerOpen(true) },
    { label: 'Renomear', onClick: () => setRenameOpen(true) },
    { label: 'Find & Replace', onClick: () => setFrOpen(true) },
    { label: 'Duplicar', onClick: handleBulkDuplicate },
    { label: 'Comprimir', onClick: handleBulkCompress },
    {
      label: 'Remover', onClick: () => {
        if (!confirm(`Remover ${selectedCount} asset(s)?`)) return;
        selectedAssetIds.forEach((id) => removeAsset(id));
        clearAssetSelection();
        toast(`${selectedCount} asset(s) removido(s)`, 'success');
      }, danger: true,
    },
  ];

  // ── Navigation ──
  const prevLabel = currentStep > 0 ? config.labels[currentStep - 1] : null;
  const nextLabel = currentStep < config.steps.length - 1 ? config.labels[currentStep + 1] : null;
  const nextStep = config.steps[currentStep + 1];
  const nextDisabled =
    (nextStep === 'dsps' && !hasContent()) ||
    (nextStep === 'config' && (!hasContent() || !hasDsp())) ||
    (nextStep === 'activate' && (!hasContent() || !hasDsp()));
  const nextHint = !hasContent() ? 'Faça upload de assets primeiro' : !hasDsp() ? 'Selecione ao menos uma DSP' : undefined;

  return (
    <div>
      <SectionHeader title="Standard Assets" description="Upload de imagens, vídeos e HTML5 para ativação direta nas DSPs" />

      <UploadZone
        accept=".jpg,.jpeg,.png,.gif,.mp4,.mov,.webm,.zip"
        multiple
        icon="🎨"
        formatHint="JPG · PNG · GIF · MP4 · ZIP"
        hasFiles={assetEntries.length > 0}
        fileSummary={assetEntries.length > 0 ? (
          <span>
            <strong>{assetEntries.length}</strong> assets
            ({[
              assetEntries.filter((a) => a.type === 'display').length ? `${assetEntries.filter((a) => a.type === 'display').length} display` : null,
              assetEntries.filter((a) => a.type === 'video').length ? `${assetEntries.filter((a) => a.type === 'video').length} video` : null,
              assetEntries.filter((a) => a.type === 'html5').length ? `${assetEntries.filter((a) => a.type === 'html5').length} HTML5` : null,
            ].filter(Boolean).join(' + ')})
          </span>
        ) : undefined}
        onFiles={handleFiles}
        onClear={() => {
          assetEntries.forEach((a) => removeAsset(a.id));
          clearAssetSelection();
        }}
      />

      {/* Assets table */}
      {assetEntries.length > 0 && (
        <div className={styles.tableSection}>
          <BulkBar count={selectedCount} actions={bulkActions} onCancel={clearAssetSelection} />

          <FilterBar
            searchValue={assetsFilterText}
            onSearchChange={(v) => setAssetsFilter({ text: v })}
            pills={{
              options: [
                { value: 'all', label: 'Todos' },
                { value: 'display', label: 'Display' },
                { value: 'video', label: 'Video' },
              ],
              active: assetsFilterType,
              onChange: (v) => setAssetsFilter({ type: v as 'all' | 'display' | 'video' }),
            }}
            sizeOptions={sizes}
            sizeValue={assetsFilterSize}
            onSizeChange={(v) => setAssetsFilter({ size: v })}
            countText={hasFilter ? `${filtered.length}/${assetEntries.length}` : ''}
            onSelectFiltered={assetsFilterText ? () => {
              selectAllAssets(filtered.map((a) => a.id));
              toast(`${filtered.length} asset(s) selecionado(s)`, 'success');
            } : undefined}
            showClear={!!hasFilter}
            onClear={() => setAssetsFilter({ type: 'all', size: 'all', text: '' })}
          />

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.cbCol}>
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every((a) => selectedAssetIds.has(a.id))}
                      onChange={(e) => {
                        if (e.target.checked) selectAllAssets(filtered.map((a) => a.id));
                        else clearAssetSelection();
                      }}
                    />
                  </th>
                  <th></th>
                  <th>Nome</th>
                  <th>Tipo</th>
                  <th>Formato</th>
                  <th>Size</th>
                  <th>Peso</th>
                  <th>Landing Page</th>
                  <th>Tracker</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a, i) => {
                  const sz = a.compressedFile ? a.compressedFile.size : a.size;
                  const wc = getWeightClass(a);
                  const ext = (a.originalFile?.name || '').split('.').pop()?.toUpperCase() || '?';
                  const suggestion = a.type === 'display' && !isIABSize(a.dimensions) ? getSizeSuggestion(a.w, a.h) : null;

                  return (
                    <tr key={a.id} style={{ animationDelay: `${i * 40}ms` }}>
                      <td className={styles.cbCol}>
                        <input
                          type="checkbox"
                          checked={selectedAssetIds.has(a.id)}
                          onChange={() => toggleAssetSelection(a.id)}
                        />
                      </td>
                      <td>
                        <PreviewThumb
                          thumb={a.thumb}
                          type={a.type}
                          name={a.name}
                          isVideo={a.type === 'video'}
                          onClick={() => openPreview(a)}
                        />
                      </td>
                      <td>
                        <input
                          className={styles.cellInput}
                          value={a.name}
                          onChange={(e) => updateAsset(a.id, { name: e.target.value })}
                          onFocus={(e) => (e.target as HTMLInputElement).dataset.prev = a.name}
                          onBlur={(e) => {
                            if (e.target.dataset.prev && e.target.dataset.prev !== a.name) {
                              e.target.classList.remove(styles.flash);
                              void e.target.offsetWidth;
                              e.target.classList.add(styles.flash);
                            }
                          }}
                        />
                      </td>
                      <td><span className={`${styles.typeBadge} ${styles[a.type]}`}>{a.type}</span></td>
                      <td><span className={styles.formatBadge}>{a.type === 'html5' ? 'HTML5' : ext}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <input
                          className={`${styles.cellInput} ${styles.mono}`}
                          style={{ width: 75 }}
                          value={a.dimensions}
                          onChange={(e) => updateAsset(a.id, { dimensions: e.target.value })}
                        />
                        {suggestion && !a.resized && (
                          <button
                            className={styles.resizeBtn}
                            onClick={() => handleResize(a, suggestion)}
                            title={`Redimensionar pra ${suggestion}`}
                          >
                            {suggestion}
                          </button>
                        )}
                        {a.resized && <span className={styles.sizeOk} title="Redimensionado">✓</span>}
                      </td>
                      <td>
                        <span className={`${styles.weightBadge} ${styles[wc]}`}>{formatBytes(sz)}{a.compressed ? ' ⚡' : ''}</span>
                        {a.type === 'html5' && wc !== 'ok' && (
                          <span className={styles.weightHint} title="HTML5 ZIPs não podem ser comprimidos pelo AdBolt">ZIP</span>
                        )}
                      </td>
                      <td>
                        <input
                          className={`${styles.cellInput} ${styles.mono}`}
                          value={a.landingPage}
                          onChange={(e) => updateAsset(a.id, { landingPage: e.target.value })}
                          onFocus={(e) => (e.target as HTMLInputElement).dataset.prev = a.landingPage}
                          onBlur={(e) => {
                            const n = normalizeUrl(e.target.value);
                            if (n !== e.target.value) updateAsset(a.id, { landingPage: n });
                            if (e.target.dataset.prev && e.target.dataset.prev !== (n || e.target.value)) {
                              e.target.classList.remove(styles.flash);
                              void e.target.offsetWidth;
                              e.target.classList.add(styles.flash);
                            }
                          }}
                          placeholder="https://..."
                        />
                      </td>
                      <td className={styles.trackerCell}>
                        <div className={styles.trackerChips}>
                          {a.trackers.map((t, ti) => (
                            <span key={ti} className={styles.trackerChip}>
                              <span className={styles.trackerScope}>
                                {t.dsps === 'all' ? 'ALL' : (Array.isArray(t.dsps) ? t.dsps.map(d => DSP_SHORT_LABELS[d] || d).join(' ') : 'ALL')}
                              </span>
                              {t.eventType && t.eventType !== 'impression' && (
                                <span className={styles.trackerEvent}>{t.eventType}</span>
                              )}
                              <span className={styles.trackerUrl} title={t.url}>{t.url}</span>
                              <button
                                className={styles.trackerRm}
                                onClick={() => removeAssetTracker(a.id, ti)}
                              >✕</button>
                            </span>
                          ))}
                          <input
                            className={styles.trackerInput}
                            placeholder="+ pixel"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleTrackerCommit(a.id, (e.target as HTMLInputElement).value);
                                (e.target as HTMLInputElement).value = '';
                              }
                            }}
                            onBlur={(e) => {
                              handleTrackerCommit(a.id, e.target.value);
                              e.target.value = '';
                            }}
                          />
                        </div>
                      </td>
                      <td className={styles.actions}>
                        <button className={styles.actionBtn} title="Duplicar" onClick={() => duplicateAsset(a.id)}>⧉</button>
                        <button className={`${styles.actionBtn} ${styles.danger}`} title="Remover" onClick={() => {
                          const snapshot = { ...a };
                          removeAsset(a.id);
                          toast(`Removido: ${a.name}`, '', () => {
                            addAssetEntries([snapshot]);
                          });
                        }}>✕</button>
                      </td>
                    </tr>
                  );
                })}
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
        items={[...selectedAssetIds].map((id) => assetEntries.find((a) => a.id === id)).filter(Boolean).map((a) => ({
          id: a!.id, name: a!.name, dimensions: a!.dimensions, type: a!.type,
        }))}
        onApply={(getNewName) => {
          const ids = [...selectedAssetIds];
          const items = ids.map((id) => assetEntries.find((a) => a.id === id)).filter(Boolean);
          items.forEach((a, i) => {
            const newName = getNewName({ id: a!.id, name: a!.name, dimensions: a!.dimensions, type: a!.type }, i);
            updateAsset(a!.id, { name: newName });
          });
          toast(`${items.length} nome(s) alterado(s)`, 'success');
        }}
      />

      <FindReplaceModal
        visible={frOpen}
        onClose={() => setFrOpen(false)}
        count={selectedAssetIds.size}
        onApply={(find, replace) => {
          let count = 0;
          selectedAssetIds.forEach((id) => {
            const a = assetEntries.find((e) => e.id === id);
            if (a && a.name.includes(find)) {
              updateAsset(id, { name: a.name.split(find).join(replace) });
              count++;
            }
          });
          toast(`${count} nome(s) atualizado(s)`, count ? 'success' : '');
        }}
      />

      <BulkTrackerModal
        visible={trackerOpen}
        onClose={() => setTrackerOpen(false)}
        count={selectedAssetIds.size}
        availableDsps={['xandr', 'dv360', 'stackadapt', 'amazondsp']}
        hasVideo={[...selectedAssetIds].some((id) => assetEntries.find((a) => a.id === id)?.type === 'video')}
        onApply={(url, format, scope, eventType) => {
          selectedAssetIds.forEach((id) => {
            addAssetTracker(id, { url, format, dsps: scope, eventType });
          });
          toast(`Tracker aplicado em ${selectedAssetIds.size} asset(s)`, 'success');
        }}
      />

      <CreativePreviewModal
        data={previewAsset ? getPreviewData(previewAsset) : null}
        onClose={() => setPreviewAsset(null)}
      />
    </div>
  );
}
