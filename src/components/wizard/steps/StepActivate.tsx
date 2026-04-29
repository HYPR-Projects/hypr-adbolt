import { useWizardStore } from '@/stores/wizard';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { ActivationProgress } from '@/components/shared/ProgressBar';
import { StepNav } from '@/components/shared/StepNav';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { genDV360 } from '@/generators/dv360';
import { genXandr } from '@/generators/xandr';
import { genStackAdapt } from '@/generators/stackadapt';
import { fillAmazonDSPTemplate } from '@/generators/amazon';
import { downloadCSV, downloadXLSX, downloadBlob } from '@/generators/download';
import { activateXandrTags } from '@/services/activation/xandr-tags';
import { activateDV360Tags } from '@/services/activation/dv360-tags';
import { activateXandrAssets } from '@/services/activation/xandr-assets';
import { activateDV360Assets } from '@/services/activation/dv360-assets';
import { uploadAssetToStorage, uploadThumbnail, uploadHtml5Preview } from '@/services/storage';
import { buildSurveyIframe } from '@/services/typeform';
import { normalizeUrl } from '@/lib/utils';
import { filterApiCapable, hasApiCapableDsp } from '@/lib/dsp-config';
import type { ActivationResult, Placement } from '@/types';
import { DSP_LABELS } from '@/types';
import styles from './StepActivate.module.css';
import { useState } from 'react';

interface DspProgress {
  dsp: string;
  label: string;
  current: number;
  total: number;
  message: string;
  status: 'loading' | 'done' | 'error';
}

export function StepActivate() {
  const store = useWizardStore();
  const { session } = useAuthStore();
  const toast = useUIStore((s) => s.toast);
  const setView = useUIStore((s) => s.setView);

  const [progress, setProgress] = useState<DspProgress[]>([]);
  const [showProgress, setShowProgress] = useState(false);

  const config = store.getStepConfig();
  const isAssetMode = store.mode === 'assets';

  // Build placements from tags and/or surveys (legacy: allPlacements = [...tagPlacements, ...surveyPl])
  const tagPlacements: Placement[] = store.mode !== 'surveys' && store.mode !== 'assets' && store.parsedData
    ? store.parsedData.placements
    : [];

  const surveyPlacements: Placement[] = store.mode !== 'tags' && store.mode !== 'assets'
    ? store.surveyEntries.flatMap((s) =>
        s.urls.filter((u) => u.formId).map((u) => ({
          placementId: `survey_${u.formId}`,
          placementName: u.title || `Survey_${s.type}`,
          dimensions: s.size,
          jsTag: buildSurveyIframe(u.formId, s.size),
          clickUrl: 'https://hypr.mobi',
          type: 'display' as const,
          vastTag: '',
          trackers: [],
          isSurvey: true,
        }))
      )
    : [];

  const allPlacements = [...tagPlacements, ...surveyPlacements];

  // ── Generate & Download Templates ──
  const handleGenerate = async () => {
    if (!allPlacements.length || !store.selectedDsps.size) return;

    const campaignSlug = (store.parsedData?.campaignName || 'Export').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);

    // DV360/Xandr/StackAdapt build their files synchronously in memory.
    // Amazon DSP is async because it fetches the official blank template
    // from /templates/amazondsp-blank.xlsx and injects the rows into the
    // pre-existing sheet — required because Amazon's parser validates the
    // template's hidden "Template Info" metadata.
    for (const dsp of store.selectedDsps) {
      const placements = allPlacements;

      if (dsp === 'dv360') {
        const f = genDV360(placements);
        downloadCSV(f.headers, f.rows, `DV360_${campaignSlug}.csv`);
      } else if (dsp === 'xandr') {
        const f = genXandr(placements, '', store.isPolitical);
        downloadXLSX(f.headers, f.rows, `Xandr_${campaignSlug}.xlsx`, { colWidths: f.colWidths });
      } else if (dsp === 'stackadapt') {
        const { file: f } = genStackAdapt(placements, store.brand, '');
        downloadXLSX(f.headers, f.rows, `StackAdapt_${campaignSlug}.xlsx`, { colWidths: f.colWidths });
      } else if (dsp === 'amazondsp') {
        try {
          const blob = await fillAmazonDSPTemplate(placements, store.amazonAdvId, store.amazonMarketplace);
          downloadBlob(blob, `AmazonDSP_${campaignSlug}.xlsx`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast(`Falha ao gerar template Amazon DSP: ${msg}`, 'error');
          return; // stop the loop — avoid a "X baixados" toast that lies about Amazon
        }
      }
    }

    toast(`${store.selectedDsps.size} template(s) baixado(s)`, 'success');
  };

  // ── Activate via API ──
  const handleActivate = async () => {
    if (!session?.access_token) {
      toast('Faça login primeiro', 'error');
      return;
    }

    // Validate landing pages for asset mode
    if (isAssetMode) {
      const missingLp = store.assetEntries.filter((a) => !a.landingPage.trim());
      if (missingLp.length) {
        toast(`${missingLp.length} asset(s) sem landing page. Preencha antes de ativar.`, 'error');
        return;
      }
      // Bloqueio só de vídeos com duration ilegível — sem duration, o edge function
      // não consegue gerar VAST válido. Bitrate alto não bloqueia mais: o edge
      // function transcoda automaticamente via Cloudinary antes de enviar pra Xandr.
      const brokenVideos = store.assetEntries.filter((a) => a.type === 'video' && (!a.duration || a.duration <= 0));
      if (brokenVideos.length) {
        toast(`${brokenVideos.length} vídeo(s) com metadata ilegível (duration=0). Re-importe os arquivos.`, 'error');
        return;
      }
      // Upload cache is validated by file hash inside uploadAssetToStorage —
      // changed files (resize/compress) get re-uploaded automatically,
      // unchanged files reuse their existing storage path.
    }

    if (store.activationDone) {
      if (!confirm('Criativos já foram ativados nesta sessão. Ativar novamente pode criar duplicados nas DSPs. Continuar?')) return;
    }

    // Validate Xandr brandUrl
    let normalizedBrandUrl = '';
    if (store.selectedDsps.has('xandr')) {
      const brandUrl = store.xandrBrandUrl.trim();
      if (!brandUrl) { toast('Preencha a Brand URL na seção Auditoria Xandr', 'error'); return; }
      normalizedBrandUrl = normalizeUrl(brandUrl);
      if (normalizedBrandUrl !== brandUrl) store.setConfig({ xandrBrandUrl: normalizedBrandUrl });
    }

    const dsps = [...store.selectedDsps];
    const creativeCount = isAssetMode ? store.assetEntries.length : allPlacements.length;
    const dspsWithApi = filterApiCapable(dsps);
    const activeDspList = dspsWithApi.map((d) => DSP_LABELS[d]).join(' e ');
    if (!dspsWithApi.length) {
      toast('Nenhuma DSP selecionada suporta ativação via API. Use "Baixar Templates".', 'error');
      return;
    }
    if (!confirm(`Ativar ${creativeCount} criativo(s) em ${activeDspList}?\n\nEssa ação envia os criativos direto pras DSPs via API.`)) return;

    store.setActivating(true);
    window.addEventListener('beforeunload', preventUnload);

    // Generate a unique session ID shared across all DSPs in this activation
    const activationSessionId = crypto.randomUUID();

    // Only API-capable DSPs participate in the activation phase; template-only
    // DSPs (StackAdapt, Amazon) get a "pendente" result pushed later so the user
    // sees why they didn't show up in the progress bar.
    const apiDsps = filterApiCapable(dsps);
    const initialProgress: DspProgress[] = apiDsps.map((d) => ({
      dsp: d, label: DSP_LABELS[d], current: 0, total: creativeCount,
      message: 'Aguardando...', status: 'loading' as const,
    }));
    setProgress(initialProgress);
    setShowProgress(true);

    const token = session.access_token;
    const results: ActivationResult[] = [];

    if (isAssetMode) {
      // ── Asset activation: upload to Storage first, then activate per DSP ──

      // Normalize landing pages (via store action, not direct mutation)
      store.normalizeAssetLandingPages();
      // Re-read from store after normalization (store creates new objects)
      const assets = useWizardStore.getState().assetEntries;

      // Phase 1: Upload all assets + thumbnails + previews to storage
      if (apiDsps.length) {
        const firstDsp = apiDsps[0];
        for (let i = 0; i < assets.length; i++) {
          const a = assets[i];
          setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? {
            ...p, current: i, message: `Upload ${i + 1}/${assets.length}: ${a.name}`,
          } : p));
          try {
            // Upload asset file to private storage
            await uploadAssetToStorage(a, token, (msg) =>
              setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? { ...p, message: msg } : p))
            );
            // Persist _storagePath to store (uploadAssetToStorage mutates the object directly)
            if (a._storagePath) {
              store.updateAsset(a.id, { _storagePath: a._storagePath, _uploadedFile: a._uploadedFile });
            }
            // Upload small thumbnail (JPEG 96x72) for table display
            if (a.thumb && !a._thumbnailUrl) {
              const thumbUrl = await uploadThumbnail(a.thumb, token);
              if (thumbUrl) store.updateAsset(a.id, { _thumbnailUrl: thumbUrl });
            }
            // Upload full-size preview to public bucket
            if (a.type === 'html5') {
              // HTML5: upload rendered HTML content
              if (a.html5Content && !a._html5PreviewUrl) {
                setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? {
                  ...p, message: `Preview ${i + 1}/${assets.length}: ${a.name}`,
                } : p));
                const previewUrl = await uploadHtml5Preview(a.html5Content, token);
                if (previewUrl) store.updateAsset(a.id, { _html5PreviewUrl: previewUrl });
              }
            }
          } catch (e) { console.error('Upload failed:', a.name, e); }
        }
        // Reset progress for Phase 2
        apiDsps.forEach((d) =>
          setProgress((prev) => prev.map((p) => p.dsp === d ? { ...p, current: 0, message: 'Aguardando ativação...' } : p))
        );
      }

      // Phase 2: Activate per DSP — re-read from store to get updated _storagePath/_thumbnailUrl
      const updatedAssets = useWizardStore.getState().assetEntries;
      if (store.selectedDsps.has('xandr')) {
        const r = await activateXandrAssets(token, updatedAssets, {
          brandUrl: normalizedBrandUrl, languageId: store.xandrLangId,
          brandId: store.xandrBrandId, sla: store.xandrSla,
        }, (cur, total, msg) =>
          setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? { ...p, current: cur, total, message: msg } : p))
        , activationSessionId);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? {
          ...p, current: updatedAssets.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }

      if (store.selectedDsps.has('dv360')) {
        const r = await activateDV360Assets(token, updatedAssets, {
          advertiserId: store.dv360AdvId,
          campaignName: store.parsedData?.campaignName || '',
          advertiserName: store.parsedData?.advertiserName || '',
          brandName: store.brand,
        }, (cur, total, msg) =>
          setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? { ...p, current: cur, total, message: msg } : p))
        , activationSessionId);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? {
          ...p, current: updatedAssets.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }
    } else {
      // ── Tag/Survey activation ──
      if (store.selectedDsps.has('xandr')) {
        const r = await activateXandrTags(token, allPlacements, {
          isPolitical: store.isPolitical, languageId: store.xandrLangId,
          brandId: store.xandrBrandId, brandUrl: normalizedBrandUrl,
          sla: store.xandrSla,
          campaignName: store.parsedData?.campaignName || 'Survey',
          advertiserName: store.parsedData?.advertiserName || '',
        }, activationSessionId);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? {
          ...p, current: allPlacements.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }

      if (store.selectedDsps.has('dv360')) {
        const r = await activateDV360Tags(token, allPlacements, {
          advertiserId: store.dv360AdvId,
          campaignName: store.parsedData?.campaignName || 'Survey',
          advertiserName: store.parsedData?.advertiserName || '',
        }, activationSessionId);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? {
          ...p, current: allPlacements.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }
    }

    // Template-only DSPs don't get an API call — we surface them here so the
    // user sees they still need to download the XLSX and upload manually.
    if (store.selectedDsps.has('stackadapt')) {
      results.push({
        dsp: 'StackAdapt',
        status: 'pending',
        detail: isAssetMode ? 'Asset upload não suportado — API pendente' : 'Use "Baixar Templates" e suba o XLSX manualmente',
      });
    }
    if (store.selectedDsps.has('amazondsp')) {
      results.push({
        dsp: 'Amazon DSP',
        status: 'pending',
        detail: isAssetMode ? 'Asset upload não suportado — API pendente' : 'Use "Baixar Templates" e suba o XLSX manualmente',
      });
    }

    store.setActivationResults(results);
    const anySuccess = results.some((r) => r.status === 'success' || r.status === 'partial');
    if (anySuccess) store.setActivationDone(true);

    store.setActivating(false);
    window.removeEventListener('beforeunload', preventUnload);
  };

  const prevLabel = config.labels[config.steps.length - 2];

  // Which cards to show on the final step:
  // - "Baixar Templates": hidden in asset mode (assets require API upload)
  // - "Ativar nas DSPs": hidden when no selected DSP is API-capable
  //   (e.g. user picked only StackAdapt/Amazon for a template-only flow)
  const showTemplateCard = !isAssetMode;
  const showActivateCard = hasApiCapableDsp(store.selectedDsps);
  const apiDspLabels = filterApiCapable([...store.selectedDsps])
    .map((d) => DSP_LABELS[d])
    .join(' e ');
  const singleCard = [showTemplateCard, showActivateCard].filter(Boolean).length < 2;

  return (
    <div>
      <SectionHeader title="Tudo pronto!" description="Escolha como deseja prosseguir com os criativos configurados." />

      <div className={`${styles.actionCards} ${singleCard ? styles.singleColumn : ''}`}>
        {showTemplateCard && (
          <div className={styles.actionCard}>
            <div className={styles.actionIcon}>📥</div>
            <div className={styles.actionTitle}>Baixar Templates</div>
            <div className={styles.actionDesc}>Gera os arquivos CSV/XLSX para upload manual nas DSPs</div>
            <button
              className={styles.btn}
              onClick={handleGenerate}
              disabled={!store.hasContent() || !store.hasDsp() || store.activating}
            >
              Gerar e Baixar
            </button>
          </div>
        )}

        {showActivateCard && (
          <div className={styles.actionCard}>
            <div className={styles.actionIcon}>⚡</div>
            <div className={styles.actionTitle}>Ativar nas DSPs</div>
            <div className={styles.actionDesc}>
              {apiDspLabels
                ? `Envia os criativos direto via API para ${apiDspLabels}`
                : 'Envia os criativos direto via API'}
            </div>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleActivate}
              disabled={!store.hasContent() || !store.hasDsp() || store.activating}
            >
              {store.activating ? 'Ativando...' : store.activationDone ? '✓ Ativado' : 'Ativar Agora'}
            </button>
          </div>
        )}
      </div>

      {/* Progress */}
      {showProgress && <ActivationProgress dsps={progress} />}

      {/* Results */}
      {store.activationResults.length > 0 && (
        <div className={styles.results}>
          <span className={styles.sectionLabel}>Ativação nas DSPs</span>
          <div className={styles.resultCards}>
            {store.activationResults.map((r, i) => {
              const ids = (r.results || []).filter((x) => x.success && x.creativeId).map((x) => x.creativeId!);
              const failed = (r.results || []).filter((x) => !x.success);
              return (
                <div key={r.dsp} className={styles.resultCard} style={{ animationDelay: `${i * 120}ms` }}>
                  <div className={styles.resultInfo}>
                    <span className={styles.resultDsp}>{r.dsp}</span>
                    <span className={`${styles.resultStatus} ${styles[r.status]}`}>
                      {r.status === 'success' ? 'Ativado' : r.status === 'partial' ? 'Parcial' : r.status === 'pending' ? 'Em breve' : 'Erro'}
                    </span>
                  </div>
                  <div className={styles.resultActions}>
                    {ids.length > 0 && (
                      <button
                        className={styles.copyBtn}
                        onClick={() => {
                          navigator.clipboard.writeText(ids.join('\n'));
                          toast('IDs copiados', 'success');
                        }}
                      >
                        Copiar IDs
                      </button>
                    )}
                    <span className={styles.resultDetail}>{r.detail}</span>
                  </div>
                  {failed.length > 0 && (
                    <div className={styles.failList}>
                      {failed.map((f, fi) => (
                        <div key={fi} className={styles.failItem}>
                          <span className={styles.failName}>{f.name || '?'}</span>
                          <span className={styles.failError}>{f.error || 'Erro desconhecido'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {store.activationDone && (
            <div className={styles.postCtas}>
              <button className={styles.btn} onClick={() => { store.resetWizard(); setView('dashboard'); }}>
                Ver no Dashboard →
              </button>
              <button className={styles.btn} onClick={() => { store.resetWizard(); setView('home'); }}>
                Criar novos criativos
              </button>
            </div>
          )}
        </div>
      )}

      <StepNav
        prevLabel={prevLabel}
        onPrev={() => store.setStep(store.currentStep - 1)}
      />
    </div>
  );
}

function preventUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = '';
}
