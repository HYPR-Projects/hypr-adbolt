import { useEffect, useState, lazy, Suspense } from 'react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { LoginScreen } from '@/components/LoginScreen';
import { Topbar } from '@/components/layout/Topbar';
import { Toast } from '@/components/layout/Toast';

// Views are code-split so the initial bundle only ships what's needed
// for the current view. Named-exports are wrapped in `.then(...)` to match
// React.lazy's default-export contract without touching the components.
const FlowSelector = lazy(() =>
  import('@/components/FlowSelector').then((m) => ({ default: m.FlowSelector })),
);
const WizardShell = lazy(() =>
  import('@/components/wizard/WizardShell').then((m) => ({ default: m.WizardShell })),
);
const Dashboard = lazy(() =>
  import('@/components/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const Settings = lazy(() =>
  import('@/components/settings/Settings').then((m) => ({ default: m.Settings })),
);
const CheckinView = lazy(() =>
  import('@/components/checkin/CheckinView').then((m) => ({ default: m.CheckinView })),
);
const AmazonCallback = lazy(() =>
  import('@/components/settings/AmazonCallback').then((m) => ({ default: m.AmazonCallback })),
);

/**
 * Detect a few special URLs the SPA needs to handle out-of-band from the
 * normal `currentView` state. OAuth callbacks land on `/auth/...` paths
 * via the Vercel SPA rewrite — we render a dedicated component instead of
 * the home view so the user sees feedback while the code is exchanged.
 */
function detectSpecialRoute(): 'amazon-callback' | null {
  const path = window.location.pathname;
  if (path === '/auth/amazon/callback') return 'amazon-callback';
  return null;
}

export function App() {
  const { user, isLoading, initialize } = useAuthStore();
  const { currentView, theme } = useUIStore();
  const [specialRoute] = useState(detectSpecialRoute);

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
          <Suspense fallback={null}>
            {specialRoute === 'amazon-callback' ? (
              <AmazonCallback />
            ) : (
              <>
                {currentView === 'home' && <FlowSelector />}
                {currentView === 'wizard' && <WizardShell />}
                {currentView === 'dashboard' && <Dashboard />}
                {currentView === 'settings' && <Settings />}
                {currentView === 'checkin' && <CheckinView />}
              </>
            )}
          </Suspense>
        </ErrorBoundary>
      </div>

      <Toast />
    </div>
  );
}
