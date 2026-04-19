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
import { CreativePreviewModal } from '@/components/shared/CreativePreview';

export function App() {

  // DEBUG: bypass auth for /debug-modal route — used for isolated preview testing
  if (typeof window !== 'undefined' && window.location.pathname === '/debug-modal') {
    const colgateTag = `<ins class='dcmads' style='display:inline-block;width:300px;height:600px'
    data-dcm-placement='N1433191.4242296HYPRN/B35590397.444842268'
    data-dcm-rendering-mode='script'
    data-dcm-https-only
    data-dcm-api-frameworks='[APIFRAMEWORKS]'
    data-dcm-omid-partner='[OMIDPARTNER]'
    data-dcm-gdpr-applies='gdpr=\${GDPR}'
    data-dcm-gdpr-consent='gdpr_consent=\${GDPR_CONSENT_755}'
    data-dcm-addtl-consent='addtl_consent=\${ADDTL_CONSENT}'
    data-dcm-ltd='false'
    data-dcm-resettable-device-id=''
    data-dcm-app-id=''>
  <script src='https://www.googletagservices.com/dcm/dcmads.js'></script>
</ins>`;
    return (
      <CreativePreviewModal
        data={{
          name: 'DEBUG_COLGATE_300x600',
          dimensions: '300x600',
          type: '3p-tag',
          tagContent: colgateTag,
          vastTagUrl: undefined,
          thumbUrl: undefined,
        }}
        onClose={() => { window.location.href = '/'; }}
      />
    );
  }

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
