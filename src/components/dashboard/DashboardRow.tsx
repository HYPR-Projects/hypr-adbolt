import { getFormatLabel } from '@/stores/dashboard';
import { DSP_LABELS, DSP_SHORT_LABELS } from '@/types';
import type { CreativeGroup, DspType } from '@/types';
import { PreviewThumb } from '@/components/shared/CreativePreview';
import { formatDate } from './helpers';
import styles from './Dashboard.module.css';

interface DashboardRowProps {
  group: CreativeGroup;
  dspKeys: DspType[];
  isExpanded: boolean;
  isSelected: boolean;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onEdit: () => void;
  onPreview: () => void;
  delay: number;
}

export function DashboardRow({ group: g, dspKeys, isExpanded, isSelected, onToggleExpand, onToggleSelect, onEdit, onPreview, delay }: DashboardRowProps) {
  const formatLabel = getFormatLabel(g);
  const isTag = formatLabel === '3P Tag' || formatLabel === 'VAST';
  const isHtml5 = formatLabel === 'HTML5';
  const previewType = isTag ? '3p-tag' : isHtml5 ? 'html5' : g.creative_type === 'video' ? 'video' : 'display';

  return (
    <>
      <tr style={{ animationDelay: `${delay}ms` }} className={isExpanded ? styles.expanded : ''} onClick={onToggleExpand}>
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect()} />
        </td>
        <td className={styles.thumbTd} onClick={(e) => e.stopPropagation()}>
          <PreviewThumb
            thumb={g.thumbnail_url || undefined}
            type={previewType}
            name={g.name}
            isVideo={g.creative_type === 'video'}
            onClick={onPreview}
          />
        </td>
        <td className={styles.nameTd}>
          <div className={styles.nameWrap}>
            <div className={styles.name} title={g.name}>
              <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16">
                <path d="M9 18l6-6-6-6" />
              </svg>
              {g.name}
            </div>
            <div className={styles.nameType}>{g.creative_type} · {dspKeys.length} DSP{dspKeys.length > 1 ? 's' : ''}</div>
          </div>
        </td>
        <td className={styles.dimCol}>{g.dimensions || '-'}</td>
        <td><span className={styles.formatBadge}>{formatLabel}</span></td>
        <td>
          <div className={styles.dspChips}>
            {dspKeys.map((k) => {
              const d = g.dsps[k];
              return (
                <div key={k} className={styles.dspChip}>
                  <span className={`${styles.auditDot} ${styles[d.audit_status]}`} />
                  <span className={styles.chipLabel}>{DSP_SHORT_LABELS[k]}</span>
                  <span className={styles.chipStatus}>{d.audit_status}</span>
                </div>
              );
            })}
          </div>
        </td>
        <td className={styles.metaCol}>{g.created_by_name}</td>
        <td className={styles.metaCol}>{formatDate(g.created_at)}</td>
        <td><button className={styles.editBtn} onClick={(e) => { e.stopPropagation(); onEdit(); }}>Editar</button></td>
      </tr>
      {isExpanded && (
        <tr className={styles.expandRow}>
          <td />
          <td colSpan={8}>
            <div className={styles.expandInner}>
              {dspKeys.map((k) => {
                const d = g.dsps[k];
                return (
                  <div key={k} className={styles.expandDsp}>
                    <div className={styles.expandDspHeader}>
                      <span className={`${styles.dspTag} ${styles[k]}`}>{DSP_LABELS[k]}</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-tri)' }}>ID: {d.dsp_creative_id || '-'}</span>
                    </div>
                    {d.landing_page && <div className={styles.expandField}><span className={styles.expandLabel}>URL destino</span><span className={styles.expandVal}>{d.landing_page}</span></div>}
                    {d.click_url && <div className={styles.expandField}><span className={styles.expandLabel}>Click redirect</span><span className={styles.expandVal}>{d.click_url}</span></div>}
                    {!d.landing_page && !d.click_url && <div className={styles.expandField}><span className={styles.expandLabel}>URLs</span><span style={{ color: 'var(--text-tri)' }}>Nenhuma URL configurada</span></div>}
                    {d.sync_error && <div className={styles.expandField}><span className={styles.expandLabel}>Sync Error</span><span style={{ color: 'var(--error)' }}>{d.sync_error}</span></div>}
                    {(() => {
                      const cfg = (d.dsp_config || {}) as Record<string, unknown>;
                      const exchanges = (cfg.exchangeReviewStatuses || []) as Array<{ exchange: string; status: string }>;
                      if (!exchanges.length) return null;
                      return (
                        <div className={styles.expandField}>
                          <span className={styles.expandLabel}>Exchange review</span>
                          <div className={styles.exchangeList}>
                            {exchanges.map((ex, ei) => (
                              <div key={ei} className={styles.exchangeItem}>
                                <span className={`${styles.auditDot} ${styles[ex.status]}`} />
                                <span className={styles.exchangeName}>{ex.exchange}</span>
                                <span className={styles.exchangeStatus}>{ex.status}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
