import { useCallback } from 'react';
import { useWizardStore } from '@/stores/wizard';
import { useUIStore } from '@/stores/ui';
import { StepNav } from '@/components/shared/StepNav';
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

  return (
    <div>
      <div className={styles.header}>
        <h2>Surveys</h2>
        <p>Selecione o tipo de pesquisa e cole as URLs do Typeform</p>
      </div>

      <div className={styles.card}>
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
                    <span className={`${styles.urlTitle} ${!u.title ? styles.loading : ''}`}>
                      {u.title || 'Buscando...'}
                    </span>
                    {u.variant && (
                      <span className={`${styles.urlVariant} ${u.variant === 'Controle' ? styles.ctrl : ''}`}>
                        {u.variant}
                      </span>
                    )}
                  </div>
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
      </div>

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
