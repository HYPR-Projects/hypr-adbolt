import { useWizardStore } from '@/stores/wizard';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { ActivationProgress } from '@/components/shared/ProgressBar';
import { StepNav } from '@/components/shared/StepNav';
import { genDV360 } from '@/generators/dv360';
import { genXandr } from '@/generators/xandr';
import { genStackAdapt } from '@/generators/stackadapt';
import { genAmazonDSP } from '@/generators/amazon';
import { downloadCSV, downloadXLSX } from '@/generators/download';
import { activateXandrTags } from '@/services/activation/xandr-tags';
import { activateDV360Tags } from '@/services/activation/dv360-tags';
import { activateXandrAssets } from '@/services/activation/xandr-assets';
import { activateDV360Assets } from '@/services/activation/dv360-assets';
import { uploadAssetToStorage } from '@/services/storage';
import { buildSurveyIframe } from '@/services/typeform';
import { normalizeUrl } from '@/lib/utils';
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
  const handleGenerate = () => {
    if (!allPlacements.length || !store.selectedDsps.size) return;

    const campaignSlug = (store.parsedData?.campaignName || 'Export').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);

    store.selectedDsps.forEach((dsp) => {
      const placements = allPlacements;

      if (dsp === 'dv360') {
        const f = genDV360(placements);
        downloadCSV(f.headers, f.rows, `DV360_${campaignSlug}.csv`);
      }
      if (dsp === 'xandr') {
        const f = genXandr(placements, '', store.isPolitical);
        downloadXLSX(f.headers, f.rows, `Xandr_${campaignSlug}.xlsx`, { colWidths: f.colWidths });
      }
      if (dsp === 'stackadapt') {
        const { file: f } = genStackAdapt(placements, store.brand, '');
        downloadXLSX(f.headers, f.rows, `StackAdapt_${campaignSlug}.xlsx`, { colWidths: f.colWidths });
      }
      if (dsp === 'amazondsp') {
        const f = genAmazonDSP(placements, store.amazonAdvId, store.amazonMarketplace);
        downloadXLSX(f.headers, f.rows, `AmazonDSP_${campaignSlug}.xlsx`, { colWidths: f.colWidths, sheetName: f.sheetName });
      }
    });

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
      // Force fresh upload each activation (legacy behavior)
      store.resetAssetUploadState();
    }

    if (store.activationDone) {
      if (!confirm('Criativos já foram ativados nesta sessão. Ativar novamente pode criar duplicados nas DSPs. Continuar?')) return;
    }

    // Validate Xandr brandUrl
    if (store.selectedDsps.has('xandr')) {
      const brandUrl = store.xandrBrandUrl.trim();
      if (!brandUrl) { toast('Preencha a Brand URL na seção Auditoria Xandr', 'error'); return; }
      const normalized = normalizeUrl(brandUrl);
      if (normalized !== brandUrl) store.setConfig({ xandrBrandUrl: normalized });
    }

    const dsps = [...store.selectedDsps];
    const creativeCount = isAssetMode ? store.assetEntries.length : allPlacements.length;
    const activeDspList = dsps.map((d) => DSP_LABELS[d]).join(' e ');
    if (!confirm(`Ativar ${creativeCount} criativo(s) em ${activeDspList}?\n\nEssa ação envia os criativos direto pras DSPs via API.`)) return;

    store.setActivating(true);
    window.addEventListener('beforeunload', preventUnload);

    const apiDsps = dsps.filter((d) => d === 'xandr' || d === 'dv360');
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

      // Phase 1: Upload all to storage
      if (apiDsps.length) {
        const firstDsp = apiDsps[0];
        for (let i = 0; i < assets.length; i++) {
          setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? {
            ...p, current: i, message: `Upload ${i + 1}/${assets.length}: ${assets[i].name}`,
          } : p));
          try {
            await uploadAssetToStorage(assets[i], token, (msg) =>
              setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? { ...p, message: msg } : p))
            );
          } catch (e) { console.error('Upload failed:', assets[i].name, e); }
        }
        // Reset progress for Phase 2
        apiDsps.forEach((d) =>
          setProgress((prev) => prev.map((p) => p.dsp === d ? { ...p, current: 0, message: 'Aguardando ativação...' } : p))
        );
      }

      // Phase 2: Activate per DSP
      if (store.selectedDsps.has('xandr')) {
        const r = await activateXandrAssets(token, assets, {
          brandUrl: store.xandrBrandUrl, languageId: store.xandrLangId,
          brandId: store.xandrBrandId, sla: store.xandrSla,
        }, (cur, total, msg) =>
          setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? { ...p, current: cur, total, message: msg } : p))
        );
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? {
          ...p, current: assets.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }

      if (store.selectedDsps.has('dv360')) {
        const r = await activateDV360Assets(token, assets, {
          advertiserId: store.dv360AdvId,
          campaignName: store.parsedData?.campaignName || '',
          advertiserName: store.parsedData?.advertiserName || '',
          brandName: store.brand,
        }, (cur, total, msg) =>
          setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? { ...p, current: cur, total, message: msg } : p))
        );
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? {
          ...p, current: assets.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }
    } else {
      // ── Tag/Survey activation ──
      if (store.selectedDsps.has('xandr')) {
        const r = await activateXandrTags(token, allPlacements, {
          isPolitical: store.isPolitical, languageId: store.xandrLangId,
          brandId: store.xandrBrandId, brandUrl: store.xandrBrandUrl,
          sla: store.xandrSla,
          campaignName: store.parsedData?.campaignName || 'Survey',
          advertiserName: store.parsedData?.advertiserName || '',
        });
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
        });
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? {
          ...p, current: allPlacements.length, message: r.detail, status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }
    }

    // Pending DSPs
    if (store.selectedDsps.has('stackadapt')) {
      results.push({ dsp: 'StackAdapt', status: 'pending', detail: isAssetMode ? 'Asset upload pendente' : 'Integração em desenvolvimento' });
    }
    if (store.selectedDsps.has('amazondsp')) {
      results.push({ dsp: 'Amazon DSP', status: 'pending', detail: isAssetMode ? 'Asset upload pendente' : 'Apenas template — upload manual' });
    }

    store.setActivationResults(results);
    const anySuccess = results.some((r) => r.status === 'success' || r.status === 'partial');
    if (anySuccess) store.setActivationDone(true);

    store.setActivating(false);
    window.removeEventListener('beforeunload', preventUnload);
  };

  const prevLabel = config.labels[config.steps.length - 2];

  return (
    <div>
      <div className={styles.header}>
        <h2>Tudo pronto!</h2>
        <p>Escolha como deseja prosseguir com os criativos configurados.</p>
      </div>

      <div className={`${styles.actionCards} ${isAssetMode ? styles.singleColumn : ''}`}>
        {!isAssetMode && (
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

        <div className={styles.actionCard}>
          <div className={styles.actionIcon}>⚡</div>
          <div className={styles.actionTitle}>Ativar nas DSPs</div>
          <div className={styles.actionDesc}>Envia os criativos direto via API para DV360 e Xandr</div>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleActivate}
            disabled={!store.hasContent() || !store.hasDsp() || store.activating}
          >
            {store.activating ? 'Ativando...' : store.activationDone ? '✓ Ativado' : 'Ativar Agora'}
          </button>
        </div>
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
