import { useWizardStore } from '@/stores/wizard';
import { DspGrid } from '@/components/shared/DspGrid';
import { DspLogo } from '@/components/shared/DspLogo';
import { StepNav } from '@/components/shared/StepNav';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { ContentCard } from '@/components/shared/ContentCard';
import type { DspType } from '@/types';

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
    { dsp: 'dv360' as DspType, icon: <DspLogo dsp="dv360" />, subtitle: subtitles.dv360 },
    { dsp: 'stackadapt' as DspType, icon: <DspLogo dsp="stackadapt" />, subtitle: subtitles.stackadapt, unavailable: UNAVAILABLE_DSPS.has('stackadapt') },
    { dsp: 'xandr' as DspType, icon: <DspLogo dsp="xandr" />, subtitle: subtitles.xandr },
    { dsp: 'amazondsp' as DspType, icon: <DspLogo dsp="amazondsp" />, subtitle: subtitles.amazondsp, unavailable: UNAVAILABLE_DSPS.has('amazondsp') },
  ];

  const prevLabel = config.labels[currentStep - 1];
  const nextLabel = config.labels[currentStep + 1];
  const nextStep = config.steps[currentStep + 1];
  const nextDisabled =
    (nextStep === 'config' && !hasDsp()) ||
    (nextStep === 'activate' && (!hasContent() || !hasDsp()));
  const nextHint = !hasDsp() ? 'Selecione ao menos uma DSP' : undefined;

  return (
    <div>
      <SectionHeader title="DSPs de destino" description="Selecione onde os criativos serão enviados" />

      <ContentCard>
        <DspGrid cards={cards} selected={selectedDsps} onToggle={toggleDsp} />
      </ContentCard>

      <StepNav
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        nextDisabled={nextDisabled}
        nextDisabledHint={nextHint}
        onPrev={() => setStep(currentStep - 1)}
        onNext={() => setStep(currentStep + 1)}
      />
    </div>
  );
}