import { useWizardStore } from '@/stores/wizard';
import { DspGrid } from '@/components/shared/DspGrid';
import { StepNav } from '@/components/shared/StepNav';
import type { DspType } from '@/types';
import styles from './StepDsps.module.css';

const TAG_SUBTITLES: Record<string, string> = {
  dv360: 'CSV · Third-Party Tags',
  stackadapt: 'API não integrada',
  xandr: 'XLSX · Third-Party Creative',
  amazondsp: 'API não integrada',
};

const ASSET_SUBTITLES: Record<string, string> = {
  dv360: 'API · Upload direto',
  stackadapt: 'API não integrada',
  xandr: 'API · Upload direto',
  amazondsp: 'API não integrada',
};

const UNAVAILABLE_DSPS = new Set(['stackadapt', 'amazondsp']);

export function StepDsps() {
  const { mode, selectedDsps, toggleDsp, currentStep, setStep, hasContent, hasDsp } = useWizardStore();
  const config = useWizardStore((s) => s.getStepConfig());

  const isAssets = mode === 'assets';
  const subtitles = isAssets ? ASSET_SUBTITLES : TAG_SUBTITLES;

  const cards = [
    { dsp: 'dv360' as DspType, icon: 'DV', subtitle: subtitles.dv360 },
    { dsp: 'stackadapt' as DspType, icon: 'SA', subtitle: subtitles.stackadapt, unavailable: UNAVAILABLE_DSPS.has('stackadapt') },
    { dsp: 'xandr' as DspType, icon: 'XN', subtitle: subtitles.xandr },
    { dsp: 'amazondsp' as DspType, icon: 'AZ', subtitle: subtitles.amazondsp, unavailable: UNAVAILABLE_DSPS.has('amazondsp') },
  ];

  const prevLabel = config.labels[currentStep - 1];
  const nextLabel = config.labels[currentStep + 1];
  const nextStep = config.steps[currentStep + 1];
  const nextDisabled =
    (nextStep === 'config' && !hasDsp()) ||
    (nextStep === 'activate' && (!hasContent() || !hasDsp()));

  return (
    <div>
      <div className={styles.header}>
        <h2>DSPs de destino</h2>
        <p>Selecione onde os criativos serão enviados</p>
      </div>

      <div className={styles.card}>
        <DspGrid cards={cards} selected={selectedDsps} onToggle={toggleDsp} />
      </div>

      <StepNav
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        nextDisabled={nextDisabled}
        onPrev={() => setStep(currentStep - 1)}
        onNext={() => setStep(currentStep + 1)}
      />
    </div>
  );
}
