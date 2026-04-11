import styles from './StepNav.module.css';

interface StepNavProps {
  prevLabel?: string | null;
  nextLabel?: string | null;
  nextDisabled?: boolean;
  nextDisabledHint?: string;
  onPrev?: () => void;
  onNext?: () => void;
}

export function StepNav({ prevLabel, nextLabel, nextDisabled, nextDisabledHint, onPrev, onNext }: StepNavProps) {
  return (
    <div className={styles.nav}>
      {prevLabel && onPrev ? (
        <button className={styles.btn} onClick={onPrev}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {prevLabel}
        </button>
      ) : (
        <div className={styles.spacer} />
      )}

      <div className={styles.spacer} />

      {nextLabel && onNext ? (
        <button
          className={`${styles.btn} ${styles.primary}`}
          onClick={onNext}
          disabled={nextDisabled}
          title={nextDisabled ? nextDisabledHint : undefined}
        >
          {nextLabel}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="16" height="16">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
