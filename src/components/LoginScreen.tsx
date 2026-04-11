import { useAuthStore } from '@/stores/auth';
import styles from './LoginScreen.module.css';

export function LoginScreen() {
  const { loginWithGoogle, error, isLoading } = useAuthStore();

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <div className={styles.brandLogo}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.5))' }}>
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h1 className={styles.brandTitle}>
            HYPR <span style={{ color: 'var(--brand)' }}>Ad</span>Bolt
          </h1>
        </div>

        <p className={styles.sub}>
          Geração e ativação de criativos nas DSPs.<br />
          Acesso restrito à equipe HYPR°.
        </p>

        <div className={styles.divider} />

        <button
          className={styles.btn}
          onClick={loginWithGoogle}
          disabled={isLoading}
        >
          <svg width="18" height="18" viewBox="0 0 18 18">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" />
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
          </svg>
          {isLoading ? 'Conectando...' : 'Entrar com Google'}
        </button>

        {error && (
          <div className={styles.error}>{error}</div>
        )}

        <div className={styles.footer}>
          Apenas contas <strong>@hypr.mobi</strong> têm acesso.
        </div>
      </div>
    </div>
  );
}
