import { useUIStore } from '@/stores/ui';
import styles from './Toast.module.css';

export function Toast() {
  const toasts = useUIStore((s) => s.toasts);
  const dismissToast = useUIStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  const toast = toasts[0];

  return (
    <div
      className={`${styles.toast} ${styles[toast.type] || ''} ${styles.show}`}
      role="alert"
      aria-live="assertive"
    >
      <span className={styles.msg}>
        {toast.message}
        {toast.undoAction && (
          <button
            className={styles.undo}
            onClick={() => {
              toast.undoAction?.();
              dismissToast(toast.id);
            }}
          >
            Desfazer
          </button>
        )}
      </span>
      <button
        className={styles.dismiss}
        onClick={() => dismissToast(toast.id)}
        aria-label="Fechar notificação"
      >
        ✕
      </button>
    </div>
  );
}
