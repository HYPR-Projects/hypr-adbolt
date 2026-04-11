import { useUIStore } from '@/stores/ui';
import { useWizardStore } from '@/stores/wizard';
import type { WizardMode } from '@/types';
import styles from './FlowSelector.module.css';

interface FlowCardConfig {
  mode: WizardMode;
  icon: React.ReactNode;
  title: string;
  desc: string;
}

const CARDS: FlowCardConfig[] = [
  {
    mode: 'tags',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
        <path d="M10 13h4" />
        <path d="M10 17h4" />
      </svg>
    ),
    title: 'Embeds & Adserver Tags',
    desc: 'Adserver script tags, VAST tags, Tap To Xp formats',
  },
  {
    mode: 'surveys',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22">
        <path d="M3 3v18h18" />
        <path d="M7 16l4-8 4 4 4-6" />
      </svg>
    ),
    title: 'Surveys',
    desc: 'Pesquisas Typeform embedded em iframes',
  },
  {
    mode: 'assets',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    ),
    title: 'Standard Assets',
    desc: 'HTML5, image or video files',
  },
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
              {card.icon}
            </div>
            <div className={styles.cardTitle}>{card.title}</div>
            <div className={styles.cardDesc}>{card.desc}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
