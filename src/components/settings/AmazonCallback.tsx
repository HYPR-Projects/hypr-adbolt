import { useEffect, useState } from 'react';
import { useUIStore } from '@/stores/ui';
import { completeAmazonOAuth, verifyAmazonAuthState, type AmazonDspCallbackResult } from '@/services/amazondsp-auth';
import { DspLogo } from '@/components/shared/DspLogo';
import styles from './AmazonCallback.module.css';

type CallbackState =
  | { phase: 'processing' }
  | { phase: 'success'; result: AmazonDspCallbackResult }
  | { phase: 'error'; message: string };

/**
 * Renders at /auth/amazon/callback after the Amazon LwA redirect.
 * Extracts `code` and `state` from the URL, verifies state (CSRF),
 * exchanges the code for tokens via the edge function, and routes the
 * user back to Settings with the result.
 *
 * Runs only once on mount — useEffect guards re-runs.
 */
export function AmazonCallback() {
  const setView = useUIStore((s) => s.setView);
  const toast = useUIStore((s) => s.toast);
  const [state, setState] = useState<CallbackState>({ phase: 'processing' });

  useEffect(() => {
    let cancelled = false;

    async function processCallback() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const returnedState = params.get('state');
      const error = params.get('error');
      const errorDescription = params.get('error_description');

      // ── Amazon returned an error directly (user denied, scope invalid, etc) ──
      if (error) {
        if (cancelled) return;
        setState({
          phase: 'error',
          message: `${error}: ${errorDescription || 'Autorização negada na Amazon'}`,
        });
        return;
      }

      if (!code) {
        if (cancelled) return;
        setState({ phase: 'error', message: 'Code OAuth ausente na URL de retorno' });
        return;
      }

      // ── CSRF check: the state we sent must match what came back ──
      if (!verifyAmazonAuthState(returnedState)) {
        if (cancelled) return;
        setState({
          phase: 'error',
          message: 'State OAuth inválido (possível CSRF). Tente conectar novamente.',
        });
        return;
      }

      try {
        const result = await completeAmazonOAuth(code);
        if (cancelled) return;
        setState({ phase: 'success', result });

        // Clear sensitive params from URL without triggering navigation
        window.history.replaceState({}, '', '/auth/amazon/callback');
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ phase: 'error', message: msg });
      }
    }

    processCallback();
    return () => { cancelled = true; };
  }, []);

  const handleReturn = () => {
    if (state.phase === 'success') {
      toast(`Amazon DSP conectada — profile ${state.result.profile_id}`, 'success');
    }
    // Clear callback URL and return to Settings
    window.history.replaceState({}, '', '/');
    setView('settings');
  };

  return (
    <main className={styles.callback} aria-label="Amazon DSP OAuth callback">
      <div className={styles.card}>
        <div className={styles.iconWrap}>
          <DspLogo dsp="amazondsp" size={48} />
        </div>

        {state.phase === 'processing' && (
          <>
            <h2 className={styles.title}>Conectando Amazon DSP</h2>
            <p className={styles.desc}>Trocando código por tokens e descobrindo o profile…</p>
            <div className={styles.spinner} aria-label="Processando" />
          </>
        )}

        {state.phase === 'success' && (
          <>
            <h2 className={styles.title}>
              <span className={styles.successDot} aria-hidden /> Conectado
            </h2>
            <p className={styles.desc}>
              Refresh token salvo. A integração já está pronta para ser usada.
            </p>
            <dl className={styles.details}>
              <div>
                <dt>Advertiser</dt>
                <dd>{state.result.advertiser_name} ({state.result.advertiser_id})</dd>
              </div>
              <div>
                <dt>Profile ID</dt>
                <dd>{state.result.profile_id}</dd>
              </div>
              <div>
                <dt>País / Moeda</dt>
                <dd>{state.result.country_code || '—'} / {state.result.currency_code || '—'}</dd>
              </div>
              <div>
                <dt>Autorizado por</dt>
                <dd>{state.result.authorized_by}</dd>
              </div>
            </dl>
            <button className={styles.btnPrimary} onClick={handleReturn}>
              Voltar para Configurações
            </button>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <h2 className={styles.title}>
              <span className={styles.errorDot} aria-hidden /> Falha na conexão
            </h2>
            <pre className={styles.errorBox}>{state.message}</pre>
            <button className={styles.btnPrimary} onClick={handleReturn}>
              Voltar para Configurações
            </button>
          </>
        )}
      </div>
    </main>
  );
}
