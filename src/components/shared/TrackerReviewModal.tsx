import { Modal } from './Modal';
import type { Tracker } from '@/types';
import type { BillingIssueKind } from '@/services/activation/billing-guard';

/** Where a blocked tracker lives, so the resolution can mutate the right store slot. */
export type TrackerLocator =
  | { kind: 'placement'; index: number; trackerIdx: number }
  | { kind: 'asset'; id: number; trackerIdx: number };

export interface ReviewIssue {
  locator: TrackerLocator;
  label: string;
  tracker: Tracker;
  reason: BillingIssueKind;
  /** A deterministic correction the system can apply on its own, when it has
   *  enough info. Only set for click trackers (video → click event; display →
   *  click-through). Never set for unknown — that would require guessing. */
  autoFix?: 'video-click' | 'to-clickthrough';
}

interface TrackerReviewModalProps {
  visible: boolean;
  onClose: () => void;
  issues: ReviewIssue[];
  /** Vouch for an unknown-vendor pixel: mark it impression + confirmed. */
  onConfirmImpression: (loc: TrackerLocator) => void;
  /** Apply the deterministic correction (move to click event / click-through). */
  onAutoFix: (iss: ReviewIssue) => void;
  /** Drop the tracker from the impression-firing array. */
  onRemove: (loc: TrackerLocator) => void;
}

const truncate = (s: string, n = 64) => (s.length > n ? s.slice(0, n) + '…' : s);

export function TrackerReviewModal({ visible, onClose, issues, onConfirmImpression, onAutoFix, onRemove }: TrackerReviewModalProps) {
  const clicks = issues.filter((i) => i.reason === 'click-as-impression');
  const unknowns = issues.filter((i) => i.reason === 'unknown-purpose');

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={`Revisar ${issues.length} tracker(s) antes de ativar`}
      maxWidth="640px"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)' }}>
            {issues.length === 0 ? 'Tudo resolvido — feche e ative.' : `${issues.length} pendente(s)`}
          </span>
          <button className="btnPrimary" onClick={onClose}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'var(--accent, #4f46e5)', color: '#fff', fontWeight: 600 }}>
            {issues.length === 0 ? 'Concluir' : 'Fechar'}
          </button>
        </div>
      }
    >
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-sec)', lineHeight: 1.5, marginTop: 0 }}>
        Esses trackers estão no array que dispara em impressão e a ativação está bloqueada até você
        resolver cada um. Um tracker de clique aqui contaria em volume de impressão.
      </p>

      {clicks.length > 0 && (
        <section style={{ marginBottom: 18 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 'var(--fs-sm)', color: 'var(--danger, #dc2626)' }}>
            ⛔ Trackers de clique ({clicks.length})
          </h4>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', margin: '0 0 10px', lineHeight: 1.5 }}>
            A URL é de clique. Onde dá, eu corrijo sozinho (manda pro evento de clique no vídeo, ou pro click-through no display); senão, remova.
          </p>
          {clicks.map((iss, k) => (
            <div key={k} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{iss.label}</div>
                <div style={urlStyle} title={iss.tracker.url}>{truncate(iss.tracker.url)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {iss.autoFix && (
                  <button onClick={() => onAutoFix(iss)} style={confirmBtn}
                    title={iss.autoFix === 'video-click' ? 'Mover para o evento de clique (VAST)' : 'Usar como click-through do criativo'}>
                    Corrigir
                  </button>
                )}
                <button onClick={() => onRemove(iss.locator)} style={dangerBtn}>Remover</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {unknowns.length > 0 && (
        <section>
          <h4 style={{ margin: '0 0 8px', fontSize: 'var(--fs-sm)', color: 'var(--warning, #d97706)' }}>
            ⚠ Propósito não identificado ({unknowns.length})
          </h4>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', margin: '0 0 10px', lineHeight: 1.5 }}>
            Vendor fora do dicionário. Confirme só se você tem certeza de que é um pixel de impressão.
          </p>
          {unknowns.map((iss, k) => (
            <div key={k} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{iss.label}</div>
                <div style={urlStyle} title={iss.tracker.url}>{truncate(iss.tracker.url)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => onConfirmImpression(iss.locator)} style={confirmBtn}>É impressão</button>
                <button onClick={() => onRemove(iss.locator)} style={dangerBtn}>Remover</button>
              </div>
            </div>
          ))}
        </section>
      )}
    </Modal>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  padding: '10px 12px', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, marginBottom: 8,
};
const labelStyle: React.CSSProperties = {
  fontSize: 'var(--fs-sm)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const urlStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', fontFamily: 'var(--mono, monospace)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const baseBtn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--fs-xs)', fontWeight: 600, flexShrink: 0,
};
const confirmBtn: React.CSSProperties = { ...baseBtn, border: '1px solid var(--accent, #4f46e5)', background: 'transparent', color: 'var(--accent, #4f46e5)' };
const dangerBtn: React.CSSProperties = { ...baseBtn, border: '1px solid var(--danger, #dc2626)', background: 'transparent', color: 'var(--danger, #dc2626)' };
