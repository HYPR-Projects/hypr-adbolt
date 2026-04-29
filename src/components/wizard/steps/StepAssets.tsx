import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useWizardStore } from '@/stores/wizard';
import { useUIStore } from '@/stores/ui';
import { useColumnResize } from '@/hooks/useColumnResize';
import { UploadZone } from '@/components/shared/UploadZone';
import { FilterBar } from '@/components/shared/FilterBar';
import { BulkBar } from '@/components/shared/BulkBar';
import { StepNav } from '@/components/shared/StepNav';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { RenameModal, FindReplaceModal, BulkTrackerModal, BulkLandingModal } from '@/components/shared/BulkModals';
import { PreviewThumb, CreativePreviewModal } from '@/components/shared/CreativePreview';
import {
  getAssetType, readFileDimensions, generateThumb,
  isIABSize, getSizeSuggestion, resizeAssetImage, compressImage,
} from '@/lib/asset-processing';
import { analyzeVideo } from '@/lib/video-analysis';
import { extractZipToFiles, processHTML5Zip } from '@/lib/html5-zip';
import { analyzeTracker } from '@/parsers/tracker';
import { normalizeUrl, formatBytes } from '@/lib/utils';
import { ASSET_DSP_LIMITS, DSP_SHORT_LABELS, STORAGE_UPLOAD_LIMIT } from '@/types';
import type { AssetEntry } from '@/types';
import styles from './StepAssets.module.css';

export function StepAssets() {
  const store = useWizardStore();
  const {
    assetEntries, addAssetEntries, removeAsset, updateAsset, duplicateAsset,
    selectedAssetIds, toggleAssetSelection, selectAllAssets, clearAssetSelection,
    bulkUpdateAssets, bulkRemoveAssets,
    assetsFilterType, assetsFilterSize, assetsFilterText, setAssetsFilter,
    addAssetTracker, removeAssetTracker, getNextAssetId,
    selectedDsps, currentStep, setStep, hasContent, hasDsp,
  } = store;
  const config = store.getStepConfig();
  const toast = useUIStore((s) => s.toast);

  // O(1) asset lookups by ID — avoids repeated .find() in render loops
  const assetMap = useMemo(() => new Map(assetEntries.map((a) => [a.id, a])), [assetEntries]);

  // ── Column resize ──
  const ASSET_COLUMNS = useMemo(() => [
    { key: 'cb',      minWidth: 40,  defaultWidth: 40,  resizable: false },
    { key: 'thumb',   minWidth: 48,  defaultWidth: 60,  resizable: false },
    { key: 'name',    minWidth: 120, defaultWidth: 240 },
    { key: 'type',    minWidth: 60,  defaultWidth: 80 },
    { key: 'format',  minWidth: 50,  defaultWidth: 70 },
    { key: 'size',    minWidth: 60,  defaultWidth: 90 },
    { key: 'weight',  minWidth: 60,  defaultWidth: 80 },
    { key: 'landing', minWidth: 100, defaultWidth: 200 },
    { key: 'tracker', minWidth: 100, defaultWidth: 220 },
    { key: 'actions', minWidth: 40,  defaultWidth: 56,  resizable: false },
  ], []);
  const { headerProps, ResizeHandle, tableStyle } = useColumnResize({
    storageKey: 'assets-table-v2',
    columns: ASSET_COLUMNS,
  });

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
        if (file.size > STORAGE_UPLOAD_LIMIT) {
          const limitMb = Math.round(STORAGE_UPLOAD_LIMIT / (1024 * 1024));
          toast(`"${file.name}" (${formatBytes(file.size)}) excede o limite de ${limitMb}MB. Comprima o arquivo antes de subir.`, 'error');
          continue;
        }
        try {
          const thumb = await generateThumb(file, type);
          if (type === 'video') {
            // Análise mais rica pra video: bitrate + codec + status. Permite UI
            // mostrar warning/erro antes do upload e habilita botão Otimizar.
            const v = await analyzeVideo(file);
            newEntries.push({
              id: getNextAssetId(),
              type,
              file,
              originalFile: file,
              name: file.name.replace(/\.\w+$/, ''),
              dimensions: `${v.w}x${v.h}`,
              w: v.w,
              h: v.h,
              duration: v.duration,
              size: file.size,
              thumb,
              landingPage: '',
              trackers: [],
              compressed: false,
              compressedFile: null,
              bitrateKbps: v.bitrateKbps,
              videoCodec: v.codec,
              videoStatus: v.status,
              videoWarnings: v.warnings,
            });
          } else {
            const dims = await readFileDimensions(file, type);
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
          }
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
    // When DSPs selected, use those. Otherwise preview with active DSPs only (exclude pending API integrations)
    const ACTIVE_DSPS = ['xandr', 'dv360'];
    const dspList = selectedDsps.size > 0
      ? [...selectedDsps]
      : ACTIVE_DSPS;
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
    const entry = assetMap.get(assetId);
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
          _storagePath: undefined,
          _uploadedFile: undefined,
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
  const [landingOpen, setLandingOpen] = useState(false);
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
    const selected = ids.map((id) => assetMap.get(id)).filter(Boolean) as AssetEntry[];
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
      ASSET_DSP_LIMITS.xandr.display, // fallback to most restrictive active DSP
    );

    let compressed = 0;
    for (const a of displayAssets) {
      // Use the current file (may be resized) instead of always using originalFile
      const sourceFile = a.file || a.originalFile;
      const result = await compressImage(sourceFile, maxBytes);
      if (result.compressed) {
        updateAsset(a.id, {
          compressedFile: result.file,
          size: result.file.size,
          compressed: true,
          _storagePath: undefined,
          _uploadedFile: undefined,
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
    { label: 'Landing Page', onClick: () => setLandingOpen(true) },
    { label: '+ Tracker', onClick: () => setTrackerOpen(true) },
    { label: 'Renomear', onClick: () => setRenameOpen(true) },
    { label: 'Find & Replace', onClick: () => setFrOpen(true) },
    { label: 'Duplicar', onClick: handleBulkDuplicate },
    { label: 'Comprimir', onClick: handleBulkCompress },
    {
      label: 'Remover', onClick: () => {
        if (!confirm(`Remover ${selectedCount} asset(s)?`)) return;
        bulkRemoveAssets(selectedAssetIds);
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
          bulkRemoveAssets(assetEntries.map((a) => a.id));
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
            <table className={styles.table} style={tableStyle}>
              <thead>
                <tr>
                  <th {...headerProps(0)} className={styles.cbCol}>
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every((a) => selectedAssetIds.has(a.id))}
                      onChange={(e) => {
                        if (e.target.checked) selectAllAssets(filtered.map((a) => a.id));
                        else clearAssetSelection();
                      }}
                    />
                  </th>
                  <th {...headerProps(1)}></th>
                  <th {...headerProps(2)}>Nome<ResizeHandle colIdx={2} /></th>
                  <th {...headerProps(3)}>Tipo<ResizeHandle colIdx={3} /></th>
                  <th {...headerProps(4)}>Formato<ResizeHandle colIdx={4} /></th>
                  <th {...headerProps(5)}>Size<ResizeHandle colIdx={5} /></th>
                  <th {...headerProps(6)}>Peso<ResizeHandle colIdx={6} /></th>
                  <th {...headerProps(7)}>Landing Page<ResizeHandle colIdx={7} /></th>
                  <th {...headerProps(8)}>Tracker<ResizeHandle colIdx={8} /></th>
                  <th {...headerProps(9)}></th>
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
                      <td>
                        <input
                          className={`${styles.cellInput} ${styles.mono}`}
                          value={a.dimensions}
                          onChange={(e) => updateAsset(a.id, { dimensions: e.target.value })}
                          onBlur={async (e) => {
                            // If user typed new dimensions, physically resize the file
                            const val = e.target.value.trim();
                            const match = val.match(/^(\d+)x(\d+)$/);
                            if (match && val !== `${a.w}x${a.h}` && a.type === 'display') {
                              await handleResize(a, val);
                            }
                          }}
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
                        {a.type === 'video' && a.bitrateKbps ? (
                          // Transcoding acontece no servidor (edge function via Cloudinary).
                          // Aqui o badge é só informativo — vídeos com bitrate alto vão ser
                          // otimizados automaticamente na ativação, sem ação do usuário.
                          a.videoStatus === 'fail' || a.videoStatus === 'warn' ? (
                            <span
                              className={`${styles.videoStatus} ${a.videoStatus === 'fail' ? styles.videoStatusFail : styles.videoStatusWarn}`}
                              title={`${a.bitrateKbps.toLocaleString()} kbps · ${a.duration}s · ${a.videoCodec || '?'}\nSerá otimizado automaticamente na ativação`}
                            >
                              {a.bitrateKbps.toLocaleString()} kbps
                            </span>
                          ) : (
                            <span className={styles.videoMeta} title={`${a.duration}s, codec ${a.videoCodec || '?'}`}>
                              {a.bitrateKbps.toLocaleString()} kbps
                            </span>
                          )
                        ) : null}
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
                              {t.eventType && t.eventType !== 'impression' && a.type === 'video' && (
                                <span className={styles.trackerEvent}>{t.eventType.toUpperCase()}</span>
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
        items={[...selectedAssetIds].map((id) => assetMap.get(id)).filter(Boolean).map((a) => ({
          id: a!.id, name: a!.name, dimensions: a!.dimensions, type: a!.type,
        }))}
        onApply={(getNewName) => {
          const ids = [...selectedAssetIds];
          const items = ids.map((id) => assetMap.get(id)).filter(Boolean);
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
        items={[...selectedAssetIds].map((id) => {
          const a = assetMap.get(id);
          return a ? { id, name: a.name } : null;
        }).filter(Boolean) as Array<{ id: number | string; name: string }>}
        onApply={(find, replace) => {
          let count = 0;
          selectedAssetIds.forEach((id) => {
            const a = assetMap.get(id);
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
        hasVideo={[...selectedAssetIds].some((id) => assetMap.get(id)?.type === 'video')}
        hasDisplay={[...selectedAssetIds].some((id) => { const a = assetMap.get(id); return a && a.type !== 'video'; })}
        onApply={(url, format, scope, eventType) => {
          selectedAssetIds.forEach((id) => {
            const asset = assetMap.get(id);
            // Only apply VAST eventType to video assets; display/html5 always get impression
            const resolvedEvent = asset?.type === 'video' ? eventType : undefined;
            addAssetTracker(id, { url, format, dsps: scope, eventType: resolvedEvent });
          });
          toast(`Tracker aplicado em ${selectedAssetIds.size} asset(s)`, 'success');
        }}
      />

      <BulkLandingModal
        visible={landingOpen}
        onClose={() => setLandingOpen(false)}
        count={selectedCount}
        onApply={(url) => {
          bulkUpdateAssets(selectedAssetIds, { landingPage: url });
          toast(`Landing page aplicada em ${selectedCount} asset(s)`, 'success');
        }}
      />

      <CreativePreviewModal
        data={previewAsset ? getPreviewData(previewAsset) : null}
        onClose={() => setPreviewAsset(null)}
      />
    </div>
  );
}