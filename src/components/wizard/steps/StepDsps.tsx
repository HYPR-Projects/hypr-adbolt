import { useWizardStore } from '@/stores/wizard';
import { DspGrid } from '@/components/shared/DspGrid';
import { DspLogo } from '@/components/shared/DspLogo';
import { StepNav } from '@/components/shared/StepNav';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { ContentCard } from '@/components/shared/ContentCard';
import { DSP_CAPABILITIES } from '@/lib/dsp-config';
import type { DspType } from '@/types';

// Subtitle strings per DSP, per wizard mode.
// Mode `assets` requires API activation (no way to upload assets via template);
// mode `tags` and `surveys` can always go through template generation, so
// template-only DSPs are selectable there.
const TAG_SUBTITLES: Record<DspType, string> = {
  dv360:      'CSV · Ativação direta',
  xandr:      'XLSX · Ativação direta',
  stackadapt: 'XLSX · Upload manual',
  amazondsp:  'API · Ativação direta',
};

const ASSET_SUBTITLES: Record<DspType, string> = {
  dv360:      'API · Upload direto',
  xandr:      'API · Upload direto',
  stackadapt: 'API não integrada',
  amazondsp:  'API não integrada',
};

export function StepDsps() {
  const { mode, selectedDsps, toggleDsp, currentStep, setStep, hasContent, hasDsp } = useWizardStore();
  const config = useWizardStore((s) => s.getStepConfig());

  const isAssets = mode === 'assets';
  const subtitles = isAssets ? ASSET_SUBTITLES : TAG_SUBTITLES;

  // Asset mode requires API activation; tag/survey modes only require template
  // generation (which every DSP supports today).
  const capabilityKey: 'api' | 'template' = isAssets ? 'api' : 'template';
  const isUnavailable = (dsp: DspType) => !DSP_CAPABILITIES[dsp][capabilityKey];

  const cards: { dsp: DspType; icon: React.ReactNode; subtitle: string; unavailable?: boolean }[] = [
    { dsp: 'dv360',      icon: <DspLogo dsp="dv360" />,      subtitle: subtitles.dv360,      unavailable: isUnavailable('dv360') },
    { dsp: 'stackadapt', icon: <DspLogo dsp="stackadapt" />, subtitle: subtitles.stackadapt, unavailable: isUnavailable('stackadapt') },
    { dsp: 'xandr',      icon: <DspLogo dsp="xandr" />,      subtitle: subtitles.xandr,      unavailable: isUnavailable('xandr') },
    { dsp: 'amazondsp',  icon: <DspLogo dsp="amazondsp" />,  subtitle: subtitles.amazondsp,  unavailable: isUnavailable('amazondsp') },
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
