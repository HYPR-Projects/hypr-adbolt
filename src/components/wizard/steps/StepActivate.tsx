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
import { activateAmazonDspTags } from '@/services/activation/amazondsp-tags';
import { activateXandrAssets } from '@/services/activation/xandr-assets';
import { activateDV360Assets } from '@/services/activation/dv360-assets';
import { trackerBlockReason } from '@/services/activation/billing-guard';
import { TrackerReviewModal, type ReviewIssue, type TrackerLocator } from '@/components/shared/TrackerReviewModal';
import { uploadAssetToStorage, uploadThumbnail, uploadHtml5Preview } from '@/services/storage';
import { buildSurveyIframe } from '@/services/typeform';
import { normalizeUrl, isValidUrl } from '@/lib/utils';
import { filterApiCapable, hasApiCapableDsp } from '@/lib/dsp-config';
import { getFreshToken } from '@/lib/auth-token';
import { buildAggregatedResult } from '@/services/activation/aggregate';
import type { AssetEntry, ActivationResult, Placement } from '@/types';
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
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewIssues, setReviewIssues] = useState<ReviewIssue[]>([]);

  // Build the list of billing-blocked trackers, located so they can be mutated.
  // Reads fresh store state so it stays correct after each resolution.
  const buildReviewIssues = (): ReviewIssue[] => {
    const s = useWizardStore.getState();
    const out: ReviewIssue[] = [];
    if (s.mode === 'assets') {
      for (const a of s.assetEntries) {
        a.trackers.forEach((t, ti) => {
          const reason = trackerBlockReason(t);
          if (!reason) return;
          const autoFix: ReviewIssue['autoFix'] =
            reason === 'click-as-impression' && !a.landingPage?.trim() ? 'to-clickthrough' : undefined;
          out.push({ locator: { kind: 'asset', id: a.id, trackerIdx: ti }, label: a.name, tracker: t, reason, autoFix });
        });
      }
    } else if (s.parsedData) {
      s.parsedData.placements.forEach((p, pi) => {
        p.trackers.forEach((t, ti) => {
          const reason = trackerBlockReason(t);
          if (!reason) return;
          const autoFix: ReviewIssue['autoFix'] =
            reason === 'click-as-impression' && !p.clickUrl?.trim() ? 'to-clickthrough' : undefined;
          out.push({ locator: { kind: 'placement', index: pi, trackerIdx: ti }, label: p.placementName, tracker: t, reason, autoFix });
        });
      });
    }
    return out;
  };

  const refreshReview = () => {
    const remaining = buildReviewIssues();
    setReviewIssues(remaining);
    if (!remaining.length) setReviewOpen(false);
  };

  const resolveConfirmImpression = (loc: TrackerLocator) => {
    if (loc.kind === 'placement') store.updatePlacementTracker(loc.index, loc.trackerIdx, { role: 'impression', confirmed: true });
    else store.updateAssetTracker(loc.id, loc.trackerIdx, { role: 'impression', confirmed: true });
    refreshReview();
  };

  const resolveAutoFix = (iss: ReviewIssue) => {
    const { locator, tracker, autoFix } = iss;
    if (autoFix === 'to-clickthrough') {
      // Click tracker → use as the creative's click-through, drop from the
      // impression-firing array. Only offered when click-through is empty.
      if (locator.kind === 'placement') {
        store.updatePlacement(locator.index, 'clickUrl', tracker.url);
        store.removePlacementTracker(locator.index, locator.trackerIdx);
      } else {
        store.updateAsset(locator.id, { landingPage: tracker.url });
        store.removeAssetTracker(locator.id, locator.trackerIdx);
      }
    }
    refreshReview();
  };

  const resolveRemove = (loc: TrackerLocator) => {
    if (loc.kind === 'placement') store.removePlacementTracker(loc.index, loc.trackerIdx);
    else store.removeAssetTracker(loc.id, loc.trackerIdx);
    refreshReview();
  };

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
      const invalidLp = store.assetEntries.filter((a) => !isValidUrl(a.landingPage));
      if (invalidLp.length) {
        const first = invalidLp.slice(0, 3).map((a) => a.name).join(', ');
        const extra = invalidLp.length > 3 ? ` +${invalidLp.length - 3}` : '';
        toast(`${invalidLp.length} asset(s) com landing page inválida: ${first}${extra}`, 'error');
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
    } else {
      // Tag/survey mode: validate clickUrl when present (video tags allow empty)
      const invalidClick = tagPlacements.filter((p) => p.clickUrl && !isValidUrl(p.clickUrl));
      if (invalidClick.length) {
        const first = invalidClick.slice(0, 3).map((p) => p.placementName).join(', ');
        const extra = invalidClick.length > 3 ? ` +${invalidClick.length - 3}` : '';
        toast(`${invalidClick.length} tag(s) com landing page inválida: ${first}${extra}`, 'error');
        return;
      }
      // Display/native tags require a clickUrl
      const missingClick = tagPlacements.filter((p) => p.type !== 'video' && !p.clickUrl.trim());
      if (missingClick.length) {
        const first = missingClick.slice(0, 3).map((p) => p.placementName).join(', ');
        const extra = missingClick.length > 3 ? ` +${missingClick.length - 3}` : '';
        toast(`${missingClick.length} tag(s) sem landing page: ${first}${extra}`, 'error');
        return;
      }
    }

    if (store.activationDone) {
      if (!confirm('Criativos já foram ativados nesta sessão. Ativar novamente pode criar duplicados nas DSPs. Continuar?')) return;
    }

    // ── Billing guard (deterministic) ──
    // Block before any DSP call if an impression-firing tracker would actually
    // count clicks, or its purpose can't be determined. Opens a review modal so
    // the user resolves each (confirm unknown as impression, or remove).
    const review = buildReviewIssues();
    if (review.length) {
      setReviewIssues(review);
      setReviewOpen(true);
      toast(`${review.length} tracker(s) bloqueado(s) por risco de billing — revise antes de ativar.`, 'error');
      return;
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
      const allAssets = useWizardStore.getState().assetEntries;

      // Chunked processing — divide o batch em sub-batches de SUB_BATCH_SIZE.
      // Cada sub-batch executa Phase 1 + Phase 2 (Xandr + DV360) completamente
      // antes do próximo começar. Benefícios pra batches grandes (>30 criativos):
      //   - Memória do browser não acumula 240+ assets simultaneamente
      //   - Falha em 1 sub-batch não afeta os outros (já estão ativados)
      //   - Cada sub-batch é curto (~3min), JWT nem chega perto de expirar
      //   - Progresso visível por lote
      // Pra batches ≤ SUB_BATCH_SIZE comportamento é idêntico ao anterior
      // (só 1 sub-batch).
      const SUB_BATCH_SIZE = 30;
      const subBatches: AssetEntry[][] = [];
      for (let i = 0; i < allAssets.length; i += SUB_BATCH_SIZE) {
        subBatches.push(allAssets.slice(i, i + SUB_BATCH_SIZE));
      }
      const totalBatches = subBatches.length;
      const isChunked = totalBatches > 1;

      // Acumuladores agregados ao longo dos sub-batches
      const allPhase1Failures: Array<{ name: string; error: string }> = [];
      const aggXandr: Array<{ name: string; success: boolean; creativeId?: string; error?: string }> = [];
      const aggDv360: Array<{ name: string; success: boolean; creativeId?: string; error?: string }> = [];

      for (let sbi = 0; sbi < totalBatches; sbi++) {
        const subAssets = subBatches[sbi];
        const batchLabel = isChunked ? `Lote ${sbi + 1}/${totalBatches} — ` : '';

        // Phase 1: Upload assets do sub-batch atual em paralelo (chunks de 5
        // dentro do sub-batch). Retry exponencial por asset.
        if (apiDsps.length) {
          const firstDsp = apiDsps[0];
          const PARALLEL = 5;
          const RETRY_DELAYS_MS = [1000, 3000, 8000];

          const uploadOne = async (a: AssetEntry, idx: number, total: number): Promise<{ ok: boolean; name: string; error?: string }> => {
            for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
              if (attempt > 0) {
                await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
              }
              try {
                const token = await getFreshToken();
                await uploadAssetToStorage(a, token, (msg) =>
                  setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? { ...p, message: `${batchLabel}${msg} (${idx + 1}/${total})` } : p)),
                );
                if (a._storagePath) {
                  store.updateAsset(a.id, { _storagePath: a._storagePath, _uploadedFile: a._uploadedFile });
                }
                if (a.thumb && !a._thumbnailUrl) {
                  try {
                    const thumbUrl = await uploadThumbnail(a.thumb, token);
                    if (thumbUrl) store.updateAsset(a.id, { _thumbnailUrl: thumbUrl });
                  } catch (thumbErr) {
                    console.warn('Thumbnail upload failed (não-bloqueante):', a.name, thumbErr);
                  }
                }
                if (a.type === 'html5' && a.html5Content && !a._html5PreviewUrl) {
                  try {
                    const previewUrl = await uploadHtml5Preview(a.html5Content, token);
                    if (previewUrl) store.updateAsset(a.id, { _html5PreviewUrl: previewUrl });
                  } catch (previewErr) {
                    console.warn('HTML5 preview upload failed (não-bloqueante):', a.name, previewErr);
                  }
                }
                return { ok: true, name: a.name };
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (attempt < RETRY_DELAYS_MS.length) {
                  console.warn(`[phase1] Retry ${attempt + 1}/${RETRY_DELAYS_MS.length} for ${a.name}: ${msg}`);
                  continue;
                }
                console.error('Upload failed after retries:', a.name, e);
                return { ok: false, name: a.name, error: msg };
              }
            }
            return { ok: false, name: a.name, error: 'Unknown' };
          };

          const subBatchFailures: Array<{ name: string; error: string }> = [];
          const baseProcessed = sbi * SUB_BATCH_SIZE;
          for (let i = 0; i < subAssets.length; i += PARALLEL) {
            const chunk = subAssets.slice(i, i + PARALLEL);
            setProgress((prev) => prev.map((p) => p.dsp === firstDsp ? {
              ...p,
              current: baseProcessed + i,
              total: allAssets.length,
              message: `${batchLabel}Upload ${baseProcessed + i + 1}-${Math.min(baseProcessed + i + chunk.length, allAssets.length)}/${allAssets.length}`,
            } : p));
            const chunkResults = await Promise.allSettled(
              chunk.map((a, ci) => uploadOne(a, i + ci, subAssets.length)),
            );
            for (const cr of chunkResults) {
              if (cr.status === 'fulfilled' && !cr.value.ok) {
                subBatchFailures.push({ name: cr.value.name, error: cr.value.error || 'Unknown' });
              } else if (cr.status === 'rejected') {
                subBatchFailures.push({ name: 'desconhecido', error: cr.reason?.message || 'Promise rejected' });
              }
            }
          }
          allPhase1Failures.push(...subBatchFailures);

          // Pro PRIMEIRO sub-batch, se a maioria dos uploads falhar é provável
          // que tenha um problema sistêmico (rede, credencial, bucket cheio).
          // Aborta antes de tentar mais sub-batches.
          if (sbi === 0 && subBatchFailures.length > subAssets.length / 2) {
            const sample = subBatchFailures.slice(0, 3).map((f) => `• ${f.name}: ${f.error}`).join('\n');
            const proceed = confirm(
              `${subBatchFailures.length} de ${subAssets.length} uploads falharam no primeiro lote.\n\n` +
              `${sample}\n\n` +
              `Provavelmente tem um problema sistêmico (rede, storage, sessão). ` +
              `Continuar com os outros lotes mesmo assim?`,
            );
            if (!proceed) {
              store.setActivating(false);
              window.removeEventListener('beforeunload', preventUnload);
              setShowProgress(false);
              toast(`Ativação cancelada. ${subBatchFailures.length} uploads falharam.`, 'error');
              return;
            }
          }
        }

        // Reset progress dos DSPs pra esse sub-batch
        const baseProcessed = sbi * SUB_BATCH_SIZE;
        apiDsps.forEach((d) =>
          setProgress((prev) => prev.map((p) => p.dsp === d ? {
            ...p, current: baseProcessed, total: allAssets.length, message: `${batchLabel}Aguardando ativação...`,
          } : p))
        );

        // Phase 2 desse sub-batch — re-read assets do store pra pegar
        // _storagePath/_thumbnailUrl atualizados pelo Phase 1 deste batch.
        const stateAssets = useWizardStore.getState().assetEntries;
        const subAssetIds = new Set(subAssets.map((a) => a.id));
        const subUpdated = stateAssets.filter((a) => subAssetIds.has(a.id));

        // Xandr e DV360 são APIs totalmente independentes (advertisers,
        // tokens e rate limits separados). Rodar as duas em paralelo via
        // Promise.allSettled corta o tempo do sub-batch quase pela metade
        // pra batches que ativam nas duas DSPs simultaneamente. Mesmo se
        // uma falhar, a outra completa normalmente.
        const xandrPromise = store.selectedDsps.has('xandr')
          ? activateXandrAssets(getFreshToken, subUpdated, {
              brandUrl: normalizedBrandUrl, languageId: store.xandrLangId,
              brandId: store.xandrBrandId, sla: store.xandrSla,
            }, (cur, _total, msg) =>
              setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? {
                ...p, current: baseProcessed + cur, total: allAssets.length, message: `${batchLabel}${msg}`,
              } : p))
            , activationSessionId)
          : null;

        const dv360Promise = store.selectedDsps.has('dv360')
          ? activateDV360Assets(getFreshToken, subUpdated, {
              advertiserId: store.dv360AdvId,
              campaignName: store.parsedData?.campaignName || '',
              advertiserName: store.parsedData?.advertiserName || '',
              brandName: store.brand,
            }, (cur, _total, msg) =>
              setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? {
                ...p, current: baseProcessed + cur, total: allAssets.length, message: `${batchLabel}${msg}`,
              } : p))
            , activationSessionId)
          : null;

        const [xandrSettled, dv360Settled] = await Promise.allSettled([
          xandrPromise ?? Promise.resolve(null),
          dv360Promise ?? Promise.resolve(null),
        ]);

        // Coleta resultado Xandr (se DSP selecionada)
        if (xandrPromise) {
          if (xandrSettled.status === 'fulfilled' && xandrSettled.value?.results) {
            aggXandr.push(...xandrSettled.value.results);
          } else if (xandrSettled.status === 'rejected') {
            // Promise rejeitou (network total, exception fora do try/catch interno).
            // Marca todos os criativos do sub-batch como falha pra refletir
            // a realidade: nenhum entrou nessa DSP nesse lote.
            const reason = xandrSettled.reason instanceof Error ? xandrSettled.reason.message : 'Activation rejected';
            console.error(`[xandr sub-batch ${sbi + 1}] rejected:`, xandrSettled.reason);
            subUpdated.forEach((a) => aggXandr.push({ name: a.name, success: false, error: reason }));
          }
        }

        // Coleta resultado DV360 (se DSP selecionada)
        if (dv360Promise) {
          if (dv360Settled.status === 'fulfilled' && dv360Settled.value?.results) {
            aggDv360.push(...dv360Settled.value.results);
          } else if (dv360Settled.status === 'rejected') {
            const reason = dv360Settled.reason instanceof Error ? dv360Settled.reason.message : 'Activation rejected';
            console.error(`[dv360 sub-batch ${sbi + 1}] rejected:`, dv360Settled.reason);
            subUpdated.forEach((a) => aggDv360.push({ name: a.name, success: false, error: reason }));
          }
        }
      }

      // Agrega resultados de todos os sub-batches em um único ActivationResult
      // por DSP. Lógica em src/services/activation/aggregate.ts (testável).
      if (store.selectedDsps.has('xandr')) {
        const r = buildAggregatedResult('Xandr', aggXandr);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'xandr' ? {
          ...p, current: allAssets.length, total: allAssets.length, message: r.detail,
          status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }
      if (store.selectedDsps.has('dv360')) {
        const r = buildAggregatedResult('DV360', aggDv360);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'dv360' ? {
          ...p, current: allAssets.length, total: allAssets.length, message: r.detail,
          status: r.status === 'success' ? 'done' : 'error',
        } : p));
      }

      // Resumo agregado de falhas Phase 1
      if (allPhase1Failures.length > 0) {
        toast(
          `${allPhase1Failures.length} de ${allAssets.length} uploads falharam ao longo da ativação. ` +
          `Cheque os logs do navegador (F12) pra detalhes.`,
          'error',
        );
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

      if (store.selectedDsps.has('amazondsp')) {
        const r = await activateAmazonDspTags(token, allPlacements, {
          campaignName: store.parsedData?.campaignName || 'Survey',
          advertiserName: store.parsedData?.advertiserName || '',
          brandName: store.brand,
          sourceType: store.mode === 'surveys' ? 'surveys' : 'tags',
        }, activationSessionId);
        results.push(r);
        setProgress((prev) => prev.map((p) => p.dsp === 'amazondsp' ? {
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
    if (store.selectedDsps.has('amazondsp') && isAssetMode) {
      results.push({
        dsp: 'Amazon DSP',
        status: 'pending',
        detail: 'Asset upload na Amazon DSP ainda não suportado — use "Baixar Templates" e suba o XLSX manualmente',
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

  // Pre-flight: landing page validation gates the Activate button.
  // DSPs (DV360 in particular) reject creatives with invalid exit-event URLs
  // server-side after the create call (CREATIVE_EXIT_EVENT_CLICK_TAG_INVALID_URL),
  // resulting in partial activations. Catch invalid URLs client-side first.
  const invalidLandingNames: string[] = isAssetMode
    ? store.assetEntries.filter((a) => !isValidUrl(a.landingPage)).map((a) => a.name)
    : tagPlacements
        .filter((p) => (p.type !== 'video' && !p.clickUrl.trim()) || (p.clickUrl && !isValidUrl(p.clickUrl)))
        .map((p) => p.placementName);
  const hasInvalidLanding = invalidLandingNames.length > 0;
  const invalidPreview = invalidLandingNames.slice(0, 3).join(', ');
  const invalidExtra = invalidLandingNames.length > 3 ? ` +${invalidLandingNames.length - 3}` : '';

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
            {hasInvalidLanding && (
              <div className={styles.invalidWarning}>
                <strong>{invalidLandingNames.length}</strong> {invalidLandingNames.length === 1 ? 'criativo com' : 'criativos com'} landing page inválida — corrija na etapa anterior antes de ativar.
                <div className={styles.invalidList}>{invalidPreview}{invalidExtra}</div>
              </div>
            )}
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleActivate}
              disabled={!store.hasContent() || !store.hasDsp() || store.activating || hasInvalidLanding}
              title={hasInvalidLanding ? 'Há landing pages inválidas. Volte para corrigir.' : undefined}
            >
              {store.activating ? 'Ativando...' : store.activationDone ? '✓ Ativado' : 'Ativar Agora'}
            </button>
          </div>
        )}
      </div>

      {/* Progress */}
      {showProgress && <ActivationProgress dsps={progress} />}

      {/* Billing review */}
      <TrackerReviewModal
        visible={reviewOpen}
        onClose={() => setReviewOpen(false)}
        issues={reviewIssues}
        onConfirmImpression={resolveConfirmImpression}
        onAutoFix={resolveAutoFix}
        onRemove={resolveRemove}
      />

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
