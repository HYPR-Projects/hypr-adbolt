import { useUIStore } from '@/stores/ui';
import { useWizardStore } from '@/stores/wizard';
import type { WizardMode } from '@/types';
import styles from './FlowSelector.module.css';

interface FlowCardConfig {
  mode: WizardMode;
  icon: string;
  title: string;
  desc: string;
}

const CARDS: FlowCardConfig[] = [
  { mode: 'tags', icon: '📄', title: 'Embeds & Adserver Tags', desc: 'Adserver script tags, VAST tags, Tap To Xp formats' },
  { mode: 'surveys', icon: '📊', title: 'Surveys', desc: 'Pesquisas Typeform embedded em iframes' },
  { mode: 'assets', icon: '🎨', title: 'Standard Assets', desc: 'HTML5, image or video files' },
];

export function FlowSelector() {
  const setView = useUIStore((s) => s.setView);
  const enterWizard = useWizardStore((s) => s.enterWizard);

  const handleSelect = (mode: WizardMode) => {
    enterWizard(mode);
    setView('wizard');
  };

  return (
    <main className={styles.selector} aria-label="Seletor de fluxo">
      <div className={styles.header}>
        <h2>O que você quer criar?</h2>
        <p>Escolha o tipo de criativo para começar. Gere templates e ative nas DSPs em um fluxo guiado.</p>
      </div>
      <div className={styles.cards}>
        {CARDS.map((card, i) => (
          <div
            key={card.mode}
            className={styles.card}
            role="button"
            tabIndex={0}
            onClick={() => handleSelect(card.mode)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSelect(card.mode);
              }
            }}
            style={{ animationDelay: `${0.2 + i * 0.15}s` }}
          >
            <div className={styles.cardIcon}>
              <span>{card.icon}</span>
            </div>
            <div className={styles.cardTitle}>{card.title}</div>
            <div className={styles.cardDesc}>{card.desc}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
