import { useWizardStore } from '@/stores/wizard';
import styles from './WizardSidebar.module.css';

interface WizardSidebarProps {
  onExit: () => void;
}

export function WizardSidebar({ onExit }: WizardSidebarProps) {
  const { mode, currentStep, setStep, hasContent, hasDsp } = useWizardStore();
  const config = useWizardStore((s) => s.getStepConfig());
  const parsedData = useWizardStore((s) => s.parsedData);
  const assetEntries = useWizardStore((s) => s.assetEntries);
  const surveyEntries = useWizardStore((s) => s.surveyEntries);
  const selectedDsps = useWizardStore((s) => s.selectedDsps);

  const MODE_LABELS: Record<string, string> = {
    tags: 'Embeds & Tags',
    surveys: 'Surveys',
    assets: 'Standard Assets',
  };

  const isStepCompleted = (stepKey: string, idx: number): boolean => {
    if (idx >= currentStep) return false;
    if (stepKey === 'tags') return mode !== 'surveys' && mode !== 'assets' && !!parsedData;
    if (stepKey === 'surveys') return mode !== 'tags' && mode !== 'assets' && surveyEntries.length > 0;
    if (stepKey === 'assets') return mode === 'assets' && assetEntries.length > 0;
    if (stepKey === 'dsps') return selectedDsps.size > 0;
    if (stepKey === 'config') return selectedDsps.size > 0;
    return false;
  };

  const isStepReachable = (stepKey: string, idx: number): boolean => {
    if (idx <= currentStep) return true;
    const content = hasContent();
    const dsp = hasDsp();
    if ((stepKey === 'dsps' || stepKey === 'config' || stepKey === 'activate') && !content) return false;
    if ((stepKey === 'config' || stepKey === 'activate') && !dsp) return false;
    return true;
  };

  return (
    <nav className={styles.sidebar} aria-label="Etapas do wizard">
      <button className={styles.back} onClick={onExit}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="16" height="16">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Voltar
      </button>
      <div className={styles.modeLabel}>{MODE_LABELS[mode]}</div>
      <div className={styles.steps}>
        {config.steps.map((stepKey, i) => {
          const completed = isStepCompleted(stepKey, i);
          const active = i === currentStep;
          const reachable = isStepReachable(stepKey, i);
          const dimmed = !reachable && i > currentStep;

          const cls = [
            styles.step,
            active && styles.active,
            completed && styles.completed,
            dimmed && styles.dimmed,
          ].filter(Boolean).join(' ');

          return (
            <div key={stepKey}>
              <div
                className={cls}
                role="button"
                tabIndex={0}
                onClick={() => setStep(i)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStep(i); } }}
              >
                <div className={styles.num}>
                  {completed ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </div>
                <div className={styles.info}>
                  <div className={styles.label}>{config.labels[i]}</div>
                  <div className={styles.sublabel}>{config.sublabels[i]}</div>
                </div>
              </div>
              {i < config.steps.length - 1 && <div className={styles.connector} />}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
