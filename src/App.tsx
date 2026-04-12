import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { LoginScreen } from '@/components/LoginScreen';
import { Topbar } from '@/components/layout/Topbar';
import { Toast } from '@/components/layout/Toast';
import { FlowSelector } from '@/components/FlowSelector';
import { WizardShell } from '@/components/wizard/WizardShell';
import { Dashboard } from '@/components/dashboard/Dashboard';

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
        <ErrorBoundary>
          {currentView === 'home' && <FlowSelector />}
          {currentView === 'wizard' && <WizardShell />}
          {currentView === 'dashboard' && <Dashboard />}
        </ErrorBoundary>
      </div>

      <Toast />
    </div>
  );
}
