import { useAuthStore, getUserDisplayName, getUserAvatarUrl, getUserInitials } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import styles from './Topbar.module.css';

export function Topbar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { currentView, setView, toggleTheme, theme } = useUIStore();

  const name = getUserDisplayName(user);
  const avatarUrl = getUserAvatarUrl(user);
  const initials = getUserInitials(user);

  const isDashboard = currentView === 'dashboard';

  const handleDashToggle = () => {
    setView(isDashboard ? 'home' : 'dashboard');
  };

  return (
    <header className={styles.topbar} role="banner">
      <div className={styles.brand}>
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
          <span className="icon-sun">☀️</span>
          <span className="icon-moon">🌙</span>
        </button>

        <button className={styles.btnLogout} onClick={logout}>
          Sair
        </button>
      </div>
    </header>
  );
}
