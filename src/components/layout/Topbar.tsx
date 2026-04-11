import { useAuthStore, getUserDisplayName, getUserAvatarUrl, getUserInitials } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { useWizardStore } from '@/stores/wizard';
import styles from './Topbar.module.css';

export function Topbar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { currentView, setView, toggleTheme } = useUIStore();
  const wizardHasData = useWizardStore((s) => s.hasContent() || s.hasDsp());
  const resetWizard = useWizardStore((s) => s.resetWizard);

  const name = getUserDisplayName(user);
  const avatarUrl = getUserAvatarUrl(user);
  const initials = getUserInitials(user);

  const isDashboard = currentView === 'dashboard';

  const handleDashToggle = () => {
    setView(isDashboard ? 'home' : 'dashboard');
  };

  return (
    <header className={styles.topbar} role="banner">
      <div className={styles.brand} onClick={() => setView('home')} style={{ cursor: 'pointer' }}>
        <div className={styles.logo}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" style={{ filter: 'drop-shadow(0 0 3px rgba(255,255,255,0.4))' }}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <span className={styles.title}>
          HYPR <span style={{ color: 'var(--brand)' }}>Ad</span>Bolt
        </span>
      </div>

      <div className={styles.right}>
        <button
          className={styles.dashBtn}
          onClick={handleDashToggle}
          title="Dashboard de criativos"
        >
          {isDashboard ? (
            <svg className={styles.dashIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12l9-9 9 9" />
              <path d="M9 21V12h6v9" />
            </svg>
          ) : (
            <svg className={styles.dashIcon} viewBox="0 0 24 24" fill="currentColor">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          )}
          <span>{isDashboard ? 'Home' : 'Dashboard'}</span>
        </button>

        <div className={styles.user}>
          {avatarUrl ? (
            <img className={styles.avatar} src={avatarUrl} alt={name} width="28" height="28" />
          ) : (
            <div className={styles.initials}>{initials}</div>
          )}
          <span className={styles.name}>{name}</span>
        </div>

        <button
          className={styles.btnIcon}
          onClick={toggleTheme}
          aria-label="Alternar tema"
        >
          <span className="icon-sun">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          </span>
          <span className="icon-moon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          </span>
        </button>

        <button className={styles.btnLogout} onClick={() => {
          if (currentView === 'wizard' && wizardHasData) {
            if (!confirm('Você tem dados configurados no wizard. Sair vai descartar tudo. Continuar?')) return;
            resetWizard();
          }
          logout();
        }}>
          Sair
        </button>
      </div>
    </header>
  );
}
