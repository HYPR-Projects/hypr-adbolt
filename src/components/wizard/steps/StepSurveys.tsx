import { useCallback, useState, useEffect } from 'react';
import { useWizardStore } from '@/stores/wizard';
import { useUIStore } from '@/stores/ui';
import { StepNav } from '@/components/shared/StepNav';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { ContentCard } from '@/components/shared/ContentCard';
import { CreativePreviewModal } from '@/components/shared/CreativePreview';
import { SurveyPicker } from './SurveyPicker';
import { extractFormId, fetchTypeformTitle, detectVariant } from '@/services/typeform';
import { SURVEY_SIZES } from '@/types';
import styles from './StepSurveys.module.css';

const SURVEY_TYPES = ['Awareness', 'Associação', 'Atitude', 'Favoritismo', 'Intenção', 'Preferência'];

export function StepSurveys() {
  const {
    surveyEntries, addSurveyEntry, removeSurveyEntry,
    addSurveyUrl, removeSurveyUrl, updateSurveySize, updateSurveyUrlTitle,
    currentStep, setStep, hasContent, hasDsp, setConfig,
  } = useWizardStore();
  const config = useWizardStore((s) => s.getStepConfig());
  const toast = useUIStore((s) => s.toast);

  const [openVariantDD, setOpenVariantDD] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{ name: string; dimensions: string; tagContent: string } | null>(null);

  useEffect(() => {
    const close = () => setOpenVariantDD(null);
    const closeEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenVariantDD(null); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', closeEsc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', closeEsc); };
  }, []);

  const activeTypes = new Set(surveyEntries.map((e) => e.type));

  const handleTypeClick = (type: string) => {
    if (activeTypes.has(type)) {
      // Remove all entries of this type
      surveyEntries.filter((e) => e.type === type).forEach((e) => removeSurveyEntry(e.id));
    } else {
      addSurveyEntry(type);
    }
  };

  const handleCustomType = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = (e.target as HTMLInputElement).value.trim();
      if (val) {
        addSurveyEntry(val);
        (e.target as HTMLInputElement).value = '';
      }
    }
  };

  const autoFillBrand = useCallback((title: string) => {
    const brand = useWizardStore.getState().brand;
    if (brand) return;

    const parts = title.replace(/\s+/g, '_').split('_');
    const hyprIdx = parts.findIndex((p) => p.toUpperCase() === 'HYPR');
    if (hyprIdx < 0 || parts.length <= hyprIdx + 2) return;

    const skip = new Set(['survey', 'brand', 'promo', 'effective']);
    let start = hyprIdx + 1;
    while (start < parts.length && skip.has(parts[start].toLowerCase())) start++;
    if (start >= parts.length) return;

    const typeWords = new Set([
      'awareness', 'associacao', 'associação', 'atitude', 'favoritismo',
      'intencao', 'intenção', 'preferencia', 'preferência', 'exposto',
      'controle', 'intent', 'consideration',
    ]);
    const clientParts: string[] = [];
    for (let i = start; i < parts.length; i++) {
      if (typeWords.has(parts[i].toLowerCase())) break;
      clientParts.push(parts[i]);
    }
    if (clientParts.length) {
      setConfig({ brand: clientParts.join(' ') });
    }
  }, [setConfig]);

  const handleAddUrl = useCallback(async (entryId: number, rawUrl: string) => {
    const formId = extractFormId(rawUrl);
    if (!formId) {
      toast('URL do Typeform inválida', 'error');
      return;
    }

    // Check duplicates within same entry
    const entry = surveyEntries.find((e) => e.id === entryId);
    if (entry?.urls.some((u) => u.formId === formId)) {
      toast('Esse form já foi adicionado neste survey', 'error');
      return;
    }

    // Check duplicates across all entries
    const globalDupe = surveyEntries.find((e) => e.id !== entryId && e.urls.some((u) => u.formId === formId));
    if (globalDupe) {
      toast(`Esse form já está em "${globalDupe.type}". Use uma URL diferente.`, 'error');
      return;
    }

    // Add with empty title (loading state)
    addSurveyUrl(entryId, { url: rawUrl, formId, title: '', variant: '' });

    // Fetch title async
    try {
      const title = await fetchTypeformTitle(formId);
      const variant = detectVariant(title);
      updateSurveyUrlTitle(entryId, formId, title, variant);
      autoFillBrand(title);
    } catch {
      updateSurveyUrlTitle(entryId, formId, 'Erro ao buscar', '');
    }
  }, [surveyEntries, addSurveyUrl, updateSurveyUrlTitle, autoFillBrand, toast]);

  // Navigation
  const prevLabel = currentStep > 0 ? config.labels[currentStep - 1] : null;
  const nextLabel = currentStep < config.steps.length - 1 ? config.labels[currentStep + 1] : null;
  const nextStep = config.steps[currentStep + 1];
  const nextDisabled =
    (nextStep === 'dsps' && !hasContent()) ||
    (nextStep === 'config' && (!hasContent() || !hasDsp())) ||
    (nextStep === 'activate' && (!hasContent() || !hasDsp()));
  const nextHint = !hasContent() ? 'Adicione URLs de survey primeiro' : !hasDsp() ? 'Selecione ao menos uma DSP' : undefined;

  return (
    <div>
      <SectionHeader title="Surveys" description="Selecione o tipo de pesquisa e cole as URLs do Typeform" />

      <ContentCard>
        {/* Survey type buttons */}
        <div className={styles.types}>
          {SURVEY_TYPES.map((type) => (
            <button
              key={type}
              className={`${styles.typeBtn} ${activeTypes.has(type) ? styles.active : ''}`}
              onClick={() => handleTypeClick(type)}
            >
              {type}
            </button>
          ))}
        </div>

        {/* Custom type input */}
        <div className={styles.customWrap}>
          <input
            type="text"
            className={styles.customInput}
            placeholder="Outro tipo — pressione Enter pra adicionar"
            onKeyDown={handleCustomType}
            aria-label="Tipo personalizado de survey"
          />
        </div>

        {/* Survey entries */}
        <div className={styles.entries}>
          {surveyEntries.map((entry) => (
            <div key={entry.id} className={styles.entry}>
              <div className={styles.entryHeader}>
                <div className={styles.entryTitle}>{entry.type}</div>
                <button
                  className={styles.entryRemove}
                  onClick={() => removeSurveyEntry(entry.id)}
                  aria-label="Remover"
                >
                  ✕
                </button>
              </div>

              {/* URL rows */}
              {entry.urls.map((u, i) => (
                <div key={u.formId} className={styles.urlRow}>
                  <div className={styles.urlInfo}>
                    <input
                      className={`${styles.urlTitleInput} ${!u.title ? styles.loading : ''}`}
                      value={u.title || ''}
                      placeholder="Buscando..."
                      onChange={(e) => updateSurveyUrlTitle(entry.id, u.formId, e.target.value, u.variant)}
                    />
                    <button
                      className={`${styles.urlVariantBtn} ${
                        u.variant === 'Controle' ? styles.variantControle :
                        u.variant === 'Exposto' ? styles.variantExposto :
                        styles.variantEmpty
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        const key = `urlvar-${u.formId}`;
                        setOpenVariantDD(openVariantDD === key ? null : key);
                      }}
                    >
                      {u.variant || 'Variante'}
                      <svg viewBox="0 0 10 6" width="8" height="8"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    </button>
                    {openVariantDD === `urlvar-${u.formId}` && (
                      <div className={styles.urlVariantDrop} onClick={(e) => e.stopPropagation()}>
                        {['Controle', 'Exposto', ''].map((v) => (
                          <div
                            key={v || '_none'}
                            className={`${styles.urlVariantItem} ${u.variant === v ? styles.urlVariantItemActive : ''}`}
                            onClick={() => {
                              updateSurveyUrlTitle(entry.id, u.formId, u.title, v);
                              setOpenVariantDD(null);
                            }}
                          >
                            {v || 'Sem variante'}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    className={styles.urlPreview}
                    onClick={() => setPreviewData({
                      name: u.title || u.formId,
                      dimensions: entry.size,
                      tagContent: `<iframe src="https://form.typeform.com/to/${u.formId}" width="${entry.size.split('x')[0]}" height="${entry.size.split('x')[1]}" frameborder="0" style="border:0;" allowfullscreen></iframe>`,
                    })}
                    aria-label="Preview"
                    title="Preview"
                  >
                    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 4C5 4 1.7 8.3 1 10c.7 1.7 4 6 9 6s8.3-4.3 9-6c-.7-1.7-4-6-9-6z" /><circle cx="10" cy="10" r="3" /></svg>
                  </button>
                  <button
                    className={styles.urlRemove}
                    onClick={() => removeSurveyUrl(entry.id, i)}
                    aria-label="Remover URL"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {/* Add URL input + size pills */}
              <div className={styles.addRow}>
                <input
                  type="text"
                  className={styles.addInput}
                  placeholder="Cole a URL do Typeform e pressione Enter"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val) {
                        handleAddUrl(entry.id, val);
                        (e.target as HTMLInputElement).value = '';
                      }
                    }
                  }}
                />
                <div className={styles.sizePills}>
                  {SURVEY_SIZES.map((sz) => (
                    <button
                      key={sz}
                      className={`${styles.sizePill} ${entry.size === sz ? styles.active : ''}`}
                      onClick={() => updateSurveySize(entry.id, sz)}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </ContentCard>

      <div className={styles.pickerDivider}><span>ou selecione do Typeform</span></div>

      <SurveyPicker
        onAdd={(items) => {
          let addedCount = 0;
          for (const item of items) {
            // Always read fresh from store (previous iteration may have created entries)
            const currentEntries = useWizardStore.getState().surveyEntries;

            let entry = currentEntries.find((e) => e.type === item.type);
            if (!entry) {
              addSurveyEntry(item.type);
              const state = useWizardStore.getState();
              entry = state.surveyEntries[state.surveyEntries.length - 1];
            }
            if (!entry) continue;

            if (entry.urls.some((u) => u.formId === item.formId)) continue;

            const globalDupe = useWizardStore.getState().surveyEntries.find(
              (e) => e.id !== entry!.id && e.urls.some((u) => u.formId === item.formId)
            );
            if (globalDupe) continue;

            addSurveyUrl(entry.id, {
              url: `https://form.typeform.com/to/${item.formId}`,
              formId: item.formId,
              title: item.title,
              variant: item.variant,
            });

            if (item.size) updateSurveySize(entry.id, item.size);
            autoFillBrand(item.title);
            addedCount++;
          }
          if (addedCount) toast(`${addedCount} survey(s) adicionada(s)`, 'success');
          else toast('Surveys já adicionadas ou duplicadas', '');
        }}
      />

      <StepNav
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        nextDisabled={nextDisabled}
        nextDisabledHint={nextHint}
        onPrev={currentStep > 0 ? () => setStep(currentStep - 1) : undefined}
        onNext={currentStep < config.steps.length - 1 ? () => setStep(currentStep + 1) : undefined}
      />

      {previewData && (
        <CreativePreviewModal
          data={{
            name: previewData.name,
            dimensions: previewData.dimensions,
            type: 'survey',
            tagContent: previewData.tagContent,
          }}
          onClose={() => setPreviewData(null)}
        />
      )}
    </div>
  );
}