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
  const isSettings = currentView === 'settings';
  const isCheckin = currentView === 'checkin';

  const handleDashToggle = () => {
    setView(isDashboard ? 'home' : 'dashboard');
  };

  const handleCheckinToggle = () => {
    setView(isCheckin ? 'home' : 'checkin');
  };

  const handleSettingsToggle = () => {
    setView(isSettings ? 'home' : 'settings');
  };

  const handleLogout = () => {
    if (currentView === 'wizard' && wizardHasData) {
      if (!confirm('Você tem dados configurados no wizard. Sair vai descartar tudo. Continuar?')) return;
      resetWizard();
    }
    logout();
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
          className={styles.navBtn}
          onClick={handleCheckinToggle}
          title={isCheckin ? 'Voltar ao início' : 'Checkin de criativos'}
        >
          {isCheckin ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          )}
          <span>{isCheckin ? 'Home' : 'Checkin'}</span>
        </button>

        <button
          className={styles.navBtn}
          onClick={handleDashToggle}
          title={isDashboard ? 'Voltar ao início' : 'Dashboard de criativos'}
        >
          {isDashboard ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          )}
          <span>{isDashboard ? 'Home' : 'Dashboard'}</span>
        </button>

        <button
          className={styles.btnRound}
          onClick={handleSettingsToggle}
          aria-label={isSettings ? 'Voltar ao início' : 'Configurações'}
          title={isSettings ? 'Voltar ao início' : 'Configurações'}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <div className={styles.separator} />

        <div className={styles.user}>
          {avatarUrl ? (
            <img className={styles.avatar} src={avatarUrl} alt={name} width="28" height="28" />
          ) : (
            <div className={styles.initials}>{initials}</div>
          )}
          <span className={styles.name}>{name}</span>
        </div>

        <button
          className={styles.btnRound}
          onClick={toggleTheme}
          aria-label="Alternar tema"
          title="Alternar tema"
        >
          <span className="icon-sun">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          </span>
          <span className="icon-moon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          </span>
        </button>

        <button
          className={styles.btnRound}
          onClick={handleLogout}
          aria-label="Sair"
          title="Sair"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </header>
  );
}
