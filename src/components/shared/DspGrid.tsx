import type { DspType } from '@/types';
import { DSP_LABELS } from '@/types';
import styles from './DspGrid.module.css';

interface DspCardConfig {
  dsp: DspType;
  icon: React.ReactNode;
  subtitle: string;
  unavailable?: boolean;
}

interface DspGridProps {
  cards: DspCardConfig[];
  selected: Set<DspType>;
  onToggle: (dsp: DspType) => void;
}

export function DspGrid({ cards, selected, onToggle }: DspGridProps) {
  return (
    <div className={styles.grid}>
      {cards.map((card) => {
        const isSelected = selected.has(card.dsp);
        const classes = [
          styles.card,
          isSelected && styles.selected,
          card.unavailable && styles.unavailable,
        ].filter(Boolean).join(' ');

        return (
          <div
            key={card.dsp}
            className={classes}
            role="button"
            tabIndex={0}
            onClick={() => !card.unavailable && onToggle(card.dsp)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !card.unavailable) {
                e.preventDefault();
                onToggle(card.dsp);
              }
            }}
          >
            <div className={styles.check}>✓</div>
            <div className={styles.icon}>{card.icon}</div>
            <div className={styles.info}>
              <div className={styles.name}>{DSP_LABELS[card.dsp]}</div>
              <div className={styles.sub}>{card.subtitle}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}