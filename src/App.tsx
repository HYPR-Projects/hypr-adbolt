import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { LoginScreen } from '@/components/LoginScreen';
import { Topbar } from '@/components/layout/Topbar';
import { Toast } from '@/components/layout/Toast';
import { FlowSelector } from '@/components/FlowSelector';

export function App() {
  const { user, isLoading, initialize } = useAuthStore();
  const { currentView, theme } = useUIStore();

  // Initialize auth on mount
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Sync theme attribute on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Show nothing while checking session
  if (isLoading) {
    return null;
  }

  // Not logged in — show login screen
  if (!user) {
    return (
      <>
        <LoginScreen />
        <Toast />
      </>
    );
  }

  // Logged in — show app
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Pular para o conteúdo</a>
      <Topbar />

      <div id="main-content">
        {currentView === 'home' && <FlowSelector />}
        {currentView === 'wizard' && <WizardPlaceholder />}
        {currentView === 'dashboard' && <DashboardPlaceholder />}
      </div>

      <Toast />
    </div>
  );
}

// ── Temporary placeholders for Phases 3-6 ──

function WizardPlaceholder() {
  return (
    <div style={{ padding: '80px 48px', textAlign: 'center' }}>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8 }}>Wizard</h2>
      <p style={{ color: 'var(--text-sec)', fontSize: '0.88rem' }}>Será implementado na Fase 3</p>
    </div>
  );
}

function DashboardPlaceholder() {
  return (
    <div style={{ padding: '40px', maxWidth: 1320, margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 8 }}>Dashboard</h2>
      <p style={{ color: 'var(--text-sec)', fontSize: '0.88rem' }}>Será implementado na Fase 6</p>
    </div>
  );
}
