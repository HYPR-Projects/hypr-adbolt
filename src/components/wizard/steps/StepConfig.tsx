import { useWizardStore } from '@/stores/wizard';
import { StepNav } from '@/components/shared/StepNav';
import { useUIStore } from '@/stores/ui';
import styles from './StepConfig.module.css';

export function StepConfig() {
  const store = useWizardStore();
  const { selectedDsps, currentStep, setStep, hasContent, hasDsp, setConfig } = store;
  const config = useWizardStore((s) => s.getStepConfig());
  const toast = useUIStore((s) => s.toast);

  const hasXandr = selectedDsps.has('xandr');
  const hasDV360 = selectedDsps.has('dv360');
  const hasSA = selectedDsps.has('stackadapt');
  const hasAmazon = selectedDsps.has('amazondsp');

  const prevLabel = config.labels[currentStep - 1];
  const nextLabel = config.labels[currentStep + 1];

  const handleNext = () => {
    if (hasXandr && !store.xandrBrandUrl.trim()) {
      toast('Preencha a Brand URL na seção Auditoria Xandr', 'error');
      return;
    }
    setStep(currentStep + 1);
  };

  return (
    <div>
      <div className={styles.header}>
        <h2>Configurações</h2>
        <p>Marca e declarações da campanha</p>
      </div>

      <div className={styles.card}>
        {/* Brand (Sponsored By) - visible when StackAdapt selected */}
        {hasSA && (
          <div className={styles.row}>
            <label className={styles.label}>
              Marca (Sponsored By)
              <small>Extraída automaticamente</small>
            </label>
            <input
              className={styles.input}
              value={store.brand}
              onChange={(e) => setConfig({ brand: e.target.value })}
              placeholder="Será preenchido ao fazer upload"
            />
          </div>
        )}

        {/* Political declaration - visible when Xandr selected */}
        {hasXandr && (
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={store.isPolitical}
              onChange={(e) => setConfig({ isPolitical: e.target.checked })}
            />
            Creative é político (Xandr Political Declaration = &quot;Yes; non-EU&quot;)
          </label>
        )}

        {/* Xandr Audit Section */}
        {hasXandr && (
          <>
            <div className={styles.divider} />
            <div className={styles.sectionLabel}>Auditoria Xandr</div>

            <div className={styles.row}>
              <label className={styles.label}>Idioma do criativo<small>Obrigatório pra auditoria</small></label>
              <select
                className={styles.input}
                value={store.xandrLangId}
                onChange={(e) => setConfig({ xandrLangId: parseInt(e.target.value) })}
              >
                <option value={8}>Português</option>
                <option value={1}>English</option>
                <option value={3}>Español</option>
                <option value={5}>Français</option>
                <option value={6}>Deutsch</option>
                <option value={7}>العربية</option>
                <option value={2}>中文</option>
                <option value={4}>日本語</option>
                <option value={10}>Korean</option>
                <option value={11}>Italian</option>
              </select>
            </div>

            <div className={styles.row}>
              <label className={styles.label}>Brand ID (Xandr)<small>Se não souber, deixe vazio</small></label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={store.xandrBrandId}
                onChange={(e) => setConfig({ xandrBrandId: e.target.value })}
                placeholder="Ex: 12345 (opcional)"
              />
            </div>

            <div className={styles.row}>
              <label className={styles.label}>Brand URL<small>URL do site da marca</small></label>
              <input
                className={styles.input}
                value={store.xandrBrandUrl}
                onChange={(e) => setConfig({ xandrBrandUrl: e.target.value })}
                placeholder="https://www.marca.com.br"
              />
            </div>

            <div className={styles.row}>
              <label className={styles.label}>Tipo de auditoria<small>Prioritária pode ter custo adicional</small></label>
              <select
                className={styles.input}
                value={store.xandrSla}
                onChange={(e) => setConfig({ xandrSla: parseInt(e.target.value) })}
              >
                <option value={0}>Padrão (~24h)</option>
                <option value={2}>Prioritária (~2h)</option>
              </select>
            </div>
          </>
        )}

        {/* DV360 Config */}
        {hasDV360 && (
          <>
            <div className={styles.divider} />
            <div className={styles.sectionLabel}>Configuração DV360</div>
            <div className={styles.row}>
              <label className={styles.label}>Advertiser ID<small>Default: {store.dv360AdvId}</small></label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={store.dv360AdvId}
                onChange={(e) => setConfig({ dv360AdvId: e.target.value })}
                placeholder="1426474713"
              />
            </div>
          </>
        )}

        {/* Amazon DSP Config */}
        {hasAmazon && (
          <>
            <div className={styles.divider} />
            <div className={styles.sectionLabel}>Configuração Amazon DSP</div>
            <div className={styles.row}>
              <label className={styles.label}>Advertiser ID<small>Entity: ENTITY1AU67WNJQTDCK</small></label>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={store.amazonAdvId}
                onChange={(e) => setConfig({ amazonAdvId: e.target.value })}
                placeholder="4968167560201"
              />
            </div>
            <div className={styles.row}>
              <label className={styles.label}>Marketplace</label>
              <select
                className={styles.input}
                value={store.amazonMarketplace}
                onChange={(e) => setConfig({ amazonMarketplace: e.target.value })}
              >
                {['BR', 'US', 'MX', 'UK', 'DE', 'FR', 'ES', 'IT', 'JP', 'CA', 'AU', 'IN', 'NL', 'SE'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      <StepNav
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        nextDisabled={!hasContent() || !hasDsp()}
        onPrev={() => setStep(currentStep - 1)}
        onNext={handleNext}
      />
    </div>
  );
}
