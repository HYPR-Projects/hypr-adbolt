/**
 * URL router — two-way sync between the browser URL and the navigation stores.
 *
 * The app's navigation is store-driven (ui.currentView + wizard.mode/currentStep);
 * this layer mirrors that state into the History API and back, so refresh,
 * back/forward and deep links work without touching any of the existing
 * setView()/setStep() call sites.
 *
 * URL map:
 *   /                      → home (FlowSelector)
 *   /dashboard             → dashboard
 *   /checkin               → checkin
 *   /settings              → settings
 *   /wizard/:mode          → wizard at step 0 (mode: tags | surveys | assets)
 *   /wizard/:mode/:step    → wizard at step N (guarded by setStep prerequisites)
 *   /auth/*                → out-of-band (OAuth callbacks) — router stays out
 *
 * Rules:
 * - Wizard content lives in memory only. A fresh load of /wizard/tags/2 opens
 *   the wizard in tags mode; setStep's prerequisite guard keeps it at step 0
 *   and the URL is normalized via replaceState (never renders an empty step).
 * - An `applying` flag suppresses store-subscription pushes while a popstate
 *   is being applied, preventing pushState↔popstate loops.
 * - Unknown paths normalize to home.
 */

import { useUIStore } from '@/stores/ui';
import { useWizardStore } from '@/stores/wizard';
import { MODE_LABELS } from '@/types';
import type { AppView, WizardMode } from '@/types';

export interface ParsedRoute {
  view: AppView;
  wizardMode?: WizardMode;
  step?: number;
}

const STATIC_PATHS: Partial<Record<AppView, string>> = {
  home: '/',
  dashboard: '/dashboard',
  checkin: '/checkin',
  settings: '/settings',
};

const VIEW_TITLES: Partial<Record<AppView, string>> = {
  dashboard: 'Dashboard',
  checkin: 'Checkin',
  settings: 'Configurações',
};

const WIZARD_MODES = new Set<string>(['tags', 'surveys', 'assets']);

export function buildPath(view: AppView, mode: WizardMode, step: number): string {
  if (view === 'wizard') return `/wizard/${mode}/${step}`;
  return STATIC_PATHS[view] || '/';
}

export function parsePath(pathname: string): ParsedRoute | null {
  const clean = pathname.replace(/\/+$/, '') || '/';

  for (const [view, path] of Object.entries(STATIC_PATHS)) {
    if (clean === path) return { view: view as AppView };
  }

  const m = clean.match(/^\/wizard\/([a-z]+)(?:\/(\d+))?$/);
  if (m && WIZARD_MODES.has(m[1])) {
    return {
      view: 'wizard',
      wizardMode: m[1] as WizardMode,
      step: m[2] !== undefined ? parseInt(m[2], 10) : undefined,
    };
  }

  return null;
}

function titleFor(view: AppView, mode: WizardMode): string {
  const base = 'HYPR AdBolt';
  if (view === 'wizard') return `${MODE_LABELS[mode]} · ${base}`;
  const label = VIEW_TITLES[view];
  return label ? `${label} · ${base}` : base;
}

/** OAuth callbacks and other out-of-band paths the router must not manage. */
function isOutOfBand(pathname: string): boolean {
  return pathname.startsWith('/auth/');
}

let initialized = false;

export function initRouter(): void {
  if (initialized) return;
  initialized = true;

  if (isOutOfBand(window.location.pathname)) return;

  let applying = false;

  /** Mirror current store state into the URL + document.title. */
  const syncFromStores = (replace: boolean) => {
    const view = useUIStore.getState().currentView;
    const { mode, currentStep } = useWizardStore.getState();
    const path = buildPath(view, mode, currentStep);
    document.title = titleFor(view, mode);
    if (window.location.pathname !== path) {
      if (replace) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
  };

  /** Apply a parsed route to the stores (popstate / initial load). */
  const applyRoute = (route: ParsedRoute) => {
    applying = true;
    try {
      if (route.view === 'wizard' && route.wizardMode) {
        const wz = useWizardStore.getState();
        // Only reset the wizard when the mode actually changes — back/forward
        // within the same wizard session must keep parsed tags/assets intact.
        if (wz.mode !== route.wizardMode) wz.enterWizard(route.wizardMode);
        if (typeof route.step === 'number' && route.step !== useWizardStore.getState().currentStep) {
          // Prerequisite guard inside setStep may legitimately refuse (e.g.
          // fresh load with no content) — URL gets normalized right after.
          useWizardStore.getState().setStep(route.step);
        }
      }
      useUIStore.getState().setView(route.view);
    } finally {
      applying = false;
    }
  };

  // ── Initial load: URL → stores, then normalize URL to the accepted state ──
  const initial = parsePath(window.location.pathname) || { view: 'home' as AppView };
  applyRoute(initial);
  syncFromStores(true);

  // ── Store changes → URL (skipped while a popstate is being applied) ──
  // Consecutive synchronous store updates (e.g. resetWizard() + setView('home')
  // in the same click handler) are merged into ONE history entry via microtask,
  // otherwise the reset would push a phantom /wizard/tags/0 before the view change.
  let syncScheduled = false;
  const scheduleSync = () => {
    if (applying || syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(() => {
      syncScheduled = false;
      syncFromStores(false);
    });
  };

  let prevView = useUIStore.getState().currentView;
  useUIStore.subscribe((s) => {
    if (s.currentView === prevView) return;
    prevView = s.currentView;
    scheduleSync();
  });

  let prevMode = useWizardStore.getState().mode;
  let prevStep = useWizardStore.getState().currentStep;
  useWizardStore.subscribe((s) => {
    if (s.mode === prevMode && s.currentStep === prevStep) return;
    prevMode = s.mode;
    prevStep = s.currentStep;
    // Wizard state only owns the URL while the wizard view is active
    // (resetWizard fires on exit and must not hijack /dashboard etc.)
    if (useUIStore.getState().currentView === 'wizard') scheduleSync();
  });

  // ── Back/forward → stores ──
  window.addEventListener('popstate', () => {
    if (isOutOfBand(window.location.pathname)) return;
    const route = parsePath(window.location.pathname) || { view: 'home' as AppView };
    applyRoute(route);
    // Normalize: if a guard refused part of the route (e.g. step), make the
    // URL reflect what the app actually shows.
    syncFromStores(true);
  });
}
