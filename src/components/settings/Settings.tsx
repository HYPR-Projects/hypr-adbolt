import { useEffect, useState } from 'react';
import { DspLogo } from '@/components/shared/DspLogo';
import {
  buildAmazonAuthUrl,
  fetchAmazonDspStatus,
  type AmazonDspStatus,
} from '@/services/amazondsp-auth';
import styles from './Settings.module.css';

/**
 * Settings page — shows third-party DSP integrations.
 * Currently focused on Amazon DSP OAuth (Xandr/DV360 use service-account
 * credentials managed via Supabase secrets, no per-user OAuth).
 */
export function Settings() {
  const [amazonStatus, setAmazonStatus] = useState<AmazonDspStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await fetchAmazonDspStatus();
        if (!cancelled) setAmazonStatus(status);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleConnect = () => {
    // Navigate the top frame to Amazon — a popup risks ad blockers and the
    // SPA route handler will pick up the return on `/auth/amazon/callback`.
    window.location.href = buildAmazonAuthUrl();
  };

  return (
    <main className={styles.settings} aria-label="Configurações de integração">
      <div className={styles.header}>
        <h2>Configurações</h2>
        <p>Integrações com DSPs e serviços externos.</p>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>Integrações de DSP</h3>
          <p>Autorize o AdBolt a operar criativos via API em cada DSP.</p>
        </div>

        <div className={styles.cards}>
          {/* Amazon DSP — OAuth-based */}
          <article className={styles.card}>
            <header className={styles.cardHead}>
              <div className={styles.dspIcon}>
                <DspLogo dsp="amazondsp" size={28} />
              </div>
              <div className={styles.cardTitle}>
                <h4>Amazon DSP</h4>
                <span className={styles.cardSub}>OAuth via Login with Amazon</span>
              </div>
              <StatusBadge loading={loading} status={amazonStatus} error={error} />
            </header>

            <div className={styles.cardBody}>
              {loading && <p className={styles.muted}>Verificando status…</p>}

              {!loading && error && (
                <pre className={styles.errorBox}>{error}</pre>
              )}

              {!loading && !error && amazonStatus?.connected && (
                <dl className={styles.details}>
                  <div>
                    <dt>Advertiser</dt>
                    <dd>{amazonStatus.advertiser_name} ({amazonStatus.advertiser_id})</dd>
                  </div>
                  <div>
                    <dt>Profile ID</dt>
                    <dd>{amazonStatus.profile_id}</dd>
                  </div>
                  <div>
                    <dt>País / Moeda</dt>
                    <dd>
                      {amazonStatus.country_code || '—'} / {amazonStatus.currency_code || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Autorizado por</dt>
                    <dd>{amazonStatus.authorized_by}</dd>
                  </div>
                  <div>
                    <dt>Autorizado em</dt>
                    <dd>{formatDate(amazonStatus.authorized_at)}</dd>
                  </div>
                </dl>
              )}

              {!loading && !error && !amazonStatus?.connected && (
                <p className={styles.muted}>
                  Sem conexão. Clique em conectar para autorizar o AdBolt a criar
                  criativos no advertiser HYPR via API.
                </p>
              )}
            </div>

            <footer className={styles.cardFoot}>
              <button className={styles.btn} onClick={handleConnect}>
                {amazonStatus?.connected ? 'Reconectar' : 'Conectar Amazon DSP'}
              </button>
            </footer>
          </article>

          {/* DV360 / Xandr — managed via service-account secrets, info only */}
          <article className={`${styles.card} ${styles.cardManaged}`}>
            <header className={styles.cardHead}>
              <div className={styles.dspIcon}>
                <DspLogo dsp="dv360" size={28} />
              </div>
              <div className={styles.cardTitle}>
                <h4>DV360</h4>
                <span className={styles.cardSub}>Service account via Supabase secrets</span>
              </div>
              <span className={`${styles.badge} ${styles.badgeManaged}`}>Gerenciado</span>
            </header>
            <div className={styles.cardBody}>
              <p className={styles.muted}>
                Credenciais gerenciadas no Vault do Supabase. Sem ação necessária.
              </p>
            </div>
          </article>

          <article className={`${styles.card} ${styles.cardManaged}`}>
            <header className={styles.cardHead}>
              <div className={styles.dspIcon}>
                <DspLogo dsp="xandr" size={28} />
              </div>
              <div className={styles.cardTitle}>
                <h4>Xandr</h4>
                <span className={styles.cardSub}>API key via Supabase secrets</span>
              </div>
              <span className={`${styles.badge} ${styles.badgeManaged}`}>Gerenciado</span>
            </header>
            <div className={styles.cardBody}>
              <p className={styles.muted}>
                Credenciais gerenciadas no Vault do Supabase. Sem ação necessária.
              </p>
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}

// ── Internal helpers ──

function StatusBadge({
  loading,
  status,
  error,
}: {
  loading: boolean;
  status: AmazonDspStatus | null;
  error: string | null;
}) {
  if (loading) return <span className={`${styles.badge} ${styles.badgeNeutral}`}>...</span>;
  if (error) return <span className={`${styles.badge} ${styles.badgeError}`}>Erro</span>;
  if (status?.connected) return <span className={`${styles.badge} ${styles.badgeOk}`}>Conectado</span>;
  return <span className={`${styles.badge} ${styles.badgeOff}`}>Desconectado</span>;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
