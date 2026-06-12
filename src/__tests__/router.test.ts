/**
 * Router tests — URL ↔ store sync.
 * Note: initRouter() is module-singleton; integration tests run sequentially
 * against one initialized instance, mirroring how the app actually runs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parsePath, buildPath, initRouter } from '@/lib/router';
import { useUIStore } from '@/stores/ui';
import { useWizardStore } from '@/stores/wizard';

const flush = () => new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));

describe('parsePath / buildPath', () => {
  it('parses static views', () => {
    expect(parsePath('/')).toEqual({ view: 'home' });
    expect(parsePath('/dashboard')).toEqual({ view: 'dashboard' });
    expect(parsePath('/checkin')).toEqual({ view: 'checkin' });
    expect(parsePath('/settings')).toEqual({ view: 'settings' });
  });

  it('parses wizard routes with and without step', () => {
    expect(parsePath('/wizard/tags')).toEqual({ view: 'wizard', wizardMode: 'tags', step: undefined });
    expect(parsePath('/wizard/assets/2')).toEqual({ view: 'wizard', wizardMode: 'assets', step: 2 });
    expect(parsePath('/wizard/surveys/0')).toEqual({ view: 'wizard', wizardMode: 'surveys', step: 0 });
  });

  it('tolerates trailing slashes', () => {
    expect(parsePath('/dashboard/')).toEqual({ view: 'dashboard' });
    expect(parsePath('/wizard/tags/')).toEqual({ view: 'wizard', wizardMode: 'tags', step: undefined });
  });

  it('rejects unknown paths and invalid wizard modes', () => {
    expect(parsePath('/nope')).toBeNull();
    expect(parsePath('/wizard/banana')).toBeNull();
    expect(parsePath('/wizard/tags/abc')).toBeNull();
  });

  it('builds paths symmetric to parsing', () => {
    expect(buildPath('home', 'tags', 0)).toBe('/');
    expect(buildPath('dashboard', 'tags', 0)).toBe('/dashboard');
    expect(buildPath('wizard', 'assets', 2)).toBe('/wizard/assets/2');
  });
});

describe('initRouter integration (jsdom)', () => {
  beforeAll(() => {
    window.history.replaceState(null, '', '/dashboard');
    initRouter();
  });

  it('applies the initial URL to the stores', () => {
    expect(useUIStore.getState().currentView).toBe('dashboard');
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('setView pushes the matching path', async () => {
    useUIStore.getState().setView('checkin');
    await flush();
    expect(window.location.pathname).toBe('/checkin');
  });

  it('entering the wizard pushes /wizard/:mode/0', async () => {
    useWizardStore.getState().enterWizard('assets');
    useUIStore.getState().setView('wizard');
    await flush();
    expect(window.location.pathname).toBe('/wizard/assets/0');
  });

  it('resetWizard + setView in the same tick produce ONE final URL (no phantom entry)', async () => {
    useWizardStore.getState().resetWizard(); // mode → tags, step → 0
    useUIStore.getState().setView('home');
    await flush();
    expect(window.location.pathname).toBe('/');
  });

  it('wizard state changes do not hijack the URL outside the wizard view', async () => {
    useUIStore.getState().setView('dashboard');
    await flush();
    useWizardStore.getState().enterWizard('tags'); // wizard store changes, view stays dashboard
    await flush();
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('popstate applies the route back to the stores', async () => {
    // Currently at /dashboard; navigate to settings, then simulate back
    useUIStore.getState().setView('settings');
    await flush();
    expect(window.location.pathname).toBe('/settings');

    window.history.replaceState(null, '', '/checkin');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(useUIStore.getState().currentView).toBe('checkin');
  });

  it('popstate to a wizard step without content normalizes to step 0', async () => {
    window.history.replaceState(null, '', '/wizard/tags/2');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(useUIStore.getState().currentView).toBe('wizard');
    expect(useWizardStore.getState().currentStep).toBe(0); // guard refused step 2
    expect(window.location.pathname).toBe('/wizard/tags/0'); // URL normalized
  });
});
