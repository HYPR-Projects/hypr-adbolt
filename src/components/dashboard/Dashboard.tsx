/* eslint-disable react-hooks/exhaustive-deps */
// Zustand store refs from useDashboardStore() are stable — exhaustive-deps
// flags them incorrectly. Disabling for this file only.
import { useEffect, useCallback, useRef } from 'react';
import { useDashboardStore, getFormatLabel } from '@/stores/dashboard';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { BulkBar } from '@/components/shared/BulkBar';
import { Modal } from '@/components/shared/Modal';
import { syncCreatives as syncCreativesApi } from '@/services/sync';
import { updateCreative } from '@/services/update';
import { deleteCreatives } from '@/services/delete';
import { normalizeUrl } from '@/lib/utils';
import { DSP_LABELS, DSP_SHORT_LABELS } from '@/types';
import type { CreativeGroup, DspType } from '@/types';
import styles from './Dashboard.module.css';
import { useState } from 'react';

export function Dashboard() {
  const store = useDashboardStore();
  const session = useAuthStore((s) => s.session);
  const toast = useUIStore((s) => s.toast);

  const autoSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load on mount — runs once
  useEffect(() => {
    store.loadCreatives();
    // Auto-sync every 5 min
    autoSyncRef.current = setInterval(() => silentSync(), 300000);
    return () => { if (autoSyncRef.current) clearInterval(autoSyncRef.current); };
  }, []);

  const silentSync = useCallback(async () => {
    if (store.isSyncing || !session?.access_token) return;
    const hasPending = store.creatives.some((c) => c.audit_status !== 'approved');
    if (!hasPending && store.creatives.length > 0) return;
    store.setSyncing(true);
    try {
      await syncCreativesApi(session.access_token);
      await store.loadCreatives();
    } catch (e) { console.warn('silent sync error:', e); }
    finally { store.setSyncing(false); }
  }, [session?.access_token, store.creatives.length]);

  const handleSync = useCallback(async () => {
    if (!session?.access_token) return;
    store.setSyncing(true);
    try {
      const result = await syncCreativesApi(session.access_token);
      const parts: string[] = [];
      if (result.updated) parts.push(`${result.updated} atualizado${result.updated > 1 ? 's' : ''}`);
      if (result.deleted) parts.push(`${result.deleted} deletado${result.deleted > 1 ? 's' : ''}`);
      if (!result.updated && !result.deleted) parts.push('Tudo em dia');
      toast(`${parts.join(', ')} (${result.synced} verificados)`, 'success');
      await store.loadCreatives();
    } catch (err) { toast('Erro no sync: ' + (err as Error).message, 'error'); }
    finally { store.setSyncing(false); }
  }, [session?.access_token, toast]);

  // ── Filtered data ──
  const filtered = store.getFilteredGroups();
  const totalPages = Math.ceil(filtered.length / store.pageSize) || 1;
  const page = Math.min(store.page, totalPages - 1);
  const pageItems = filtered.slice(page * store.pageSize, (page + 1) * store.pageSize);

  // ── Stats ──
  const totalGroups = store.groups.length;
  const approved = store.creatives.filter((c) => c.audit_status === 'approved').length;
  const pending = store.creatives.filter((c) => c.audit_status === 'pending').length;
  const rejected = store.creatives.filter((c) => c.audit_status === 'rejected').length;

  // ── Multi-select dropdown values ──
  const allSizes = [...new Set(store.groups.map((g) => g.dimensions))].sort();
  const allFormats = [...new Set(store.groups.map((g) => getFormatLabel(g)))].sort();
  const allCreators = [...new Set(store.groups.map((g) => g.created_by_name).filter((n) => n !== '-'))].sort();

  // ── Sync timestamp ──
  const syncAgo = store.lastSyncTime ? formatTimeAgo(store.lastSyncTime) : '';

  // ── Bulk actions ──
  const selectedCount = store.selectedKeys.size;

  const handleBulkDelete = useCallback(async () => {
    if (!selectedCount || !session?.access_token) return;
    const keys = [...store.selectedKeys];
    const groups = keys.map((k) => store.groups.find((g) => g._gid === k)).filter(Boolean) as CreativeGroup[];
    const allIds: string[] = [];
    groups.forEach((g) => Object.values(g.dsps).forEach((d) => allIds.push(d.id)));

    if (!confirm(`Deletar ${groups.length} criativo(s)?\n\nXandr: deletados permanentemente\nDV360: arquivados\n\nEssa ação não pode ser desfeita.`)) return;

    try {
      const CHUNK = 20;
      let totalDeleted = 0, totalArchived = 0, totalFailed = 0;
      for (let i = 0; i < allIds.length; i += CHUNK) {
        const chunk = allIds.slice(i, i + CHUNK);
        try {
          const r = await deleteCreatives(session.access_token, chunk);
          totalDeleted += r.deleted;
          totalArchived += r.archived;
          totalFailed += r.failed;
        } catch { totalFailed += chunk.length; }
      }
      const parts: string[] = [];
      if (totalDeleted) parts.push(`${totalDeleted} deletado(s) na Xandr`);
      if (totalArchived) parts.push(`${totalArchived} arquivado(s) na DV360`);
      if (totalFailed) parts.push(`${totalFailed} erro(s)`);
      toast(parts.join(', ') || 'Nenhuma alteração', totalFailed ? 'error' : 'success');
      store.clearSelection();
      await store.loadCreatives();
    } catch (err) { toast('Erro: ' + (err as Error).message, 'error'); }
  }, [selectedCount, session?.access_token, store.selectedKeys, store.groups, toast]);

  const bulkActions = [
    { label: 'Editar', onClick: () => openBulkEdit() },
    { label: 'Deletar', onClick: handleBulkDelete, danger: true },
  ];

  // ── Edit modal state ──
  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editFields, setEditFields] = useState<Record<string, Record<string, string>>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editBulkKeys, setEditBulkKeys] = useState<string[] | null>(null);

  const openSingleEdit = (group: CreativeGroup) => {
    setEditBulkKeys(null);
    setEditName(group.name);
    const fields: Record<string, Record<string, string>> = {};
    for (const [dsp, d] of Object.entries(group.dsps)) {
      fields[dsp] = {
        landing_page: d.landing_page || d.click_url || '',
        click_url: dsp === 'xandr' ? (d.click_url || '') : '',
      };
    }
    setEditFields(fields);
    setEditVisible(true);
    store.setEditGroup(group);
  };

  const openBulkEdit = () => {
    const keys = [...store.selectedKeys];
    setEditBulkKeys(keys);
    setEditName('');
    setEditFields({});
    setEditVisible(true);
  };

  const handleSaveEdit = useCallback(async () => {
    if (!session?.access_token) return;
    setEditSaving(true);
    const token = session.access_token;
    let ok = 0, fail = 0;

    const groups = editBulkKeys
      ? editBulkKeys.map((k) => store.groups.find((g) => g._gid === k)).filter(Boolean) as CreativeGroup[]
      : store.editGroup ? [store.editGroup] : [];

    for (const g of groups) {
      for (const [dsp, d] of Object.entries(g.dsps)) {
        const changes: Record<string, unknown> = {};
        if (editName && (editBulkKeys || editName !== g.name)) changes.name = editName;
        const dspFields = editFields[dsp];
        if (dspFields?.landing_page !== undefined && dspFields.landing_page !== (d.landing_page || d.click_url || '')) {
          changes.landing_page = normalizeUrl(dspFields.landing_page);
        }
        if (dsp === 'xandr' && dspFields?.click_url !== undefined && dspFields.click_url !== (d.click_url || '')) {
          changes.click_url = normalizeUrl(dspFields.click_url);
        }
        if (!Object.keys(changes).length) continue;
        try {
          await updateCreative(token, d.id, changes);
          ok++;
        } catch { fail++; }
      }
    }

    if (!ok && !fail) toast('Nenhuma alteração', '');
    else if (!fail) toast(`${ok} atualização${ok > 1 ? 'ões' : ''} sincronizada${ok > 1 ? 's' : ''}`, 'success');
    else toast(`${ok} OK, ${fail} erro(s)`, 'error');

    setEditVisible(false);
    setEditSaving(false);
    store.clearSelection();
    await store.loadCreatives();
  }, [session?.access_token, editName, editFields, editBulkKeys, store.editGroup, toast]);

  return (
    <section className={styles.dashboard} aria-label="Dashboard de criativos">
      {/* Hero */}
      <div className={styles.hero}>
        <div>
          <h2 className={styles.heroTitle}>Criativos</h2>
          <div className={styles.heroSub}>
            {totalGroups} criativos em {store.creatives.length} registros
            {syncAgo && <span className={styles.syncTs}>{syncAgo}</span>}
          </div>
        </div>
        <button
          className={`${styles.syncBtn} ${store.isSyncing ? styles.loading : ''}`}
          onClick={handleSync}
          disabled={store.isSyncing}
        >
          {store.isSyncing ? 'Syncing...' : 'Sync Status'}
        </button>
      </div>

      {/* Stats */}
      <div className={styles.stats}>
        <div className={`${styles.stat} ${styles.statHero}`}>
          <div className={styles.statVal}>{totalGroups}</div>
          <div className={styles.statLabel}>Criativos</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statTop}><div className={`${styles.statDot} ${styles.cSuccess}`} /><div className={styles.statLabel}>Approved</div></div>
          <div className={styles.statVal}>{approved}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statTop}><div className={`${styles.statDot} ${styles.cWarning}`} /><div className={styles.statLabel}>Pending</div></div>
          <div className={styles.statVal}>{pending}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statTop}><div className={`${styles.statDot} ${styles.cError}`} /><div className={styles.statLabel}>Rejected</div></div>
          <div className={styles.statVal}>{rejected}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className={styles.toolbar}>
        {['all', 'xandr', 'dv360'].map((d) => (
          <button key={d} className={`${styles.pill} ${store.filterDsp === d ? styles.active : ''}`} onClick={() => store.setFilterDsp(d)}>
            {d === 'all' ? 'Todos' : DSP_LABELS[d as DspType]}
          </button>
        ))}
        <span className={styles.divider} />
        {['all', 'pending', 'approved', 'rejected'].map((a) => (
          <button key={a} className={`${styles.pill} ${store.filterAudit === a ? styles.active : ''}`} onClick={() => store.setFilterAudit(a)}>
            {a === 'all' ? 'All' : a.charAt(0).toUpperCase() + a.slice(1)}
          </button>
        ))}
        <span className={styles.divider} />
        <MultiSelect label="Size" values={allSizes} selected={store.filterSize} onToggle={(v) => store.toggleFilterMulti('size', v)} onClear={() => store.clearFilterMulti('size')} />
        <MultiSelect label="Formato" values={allFormats} selected={store.filterFormat} onToggle={(v) => store.toggleFilterMulti('format', v)} onClear={() => store.clearFilterMulti('format')} />
        <MultiSelect label="Criador" values={allCreators} selected={store.filterCreator} onToggle={(v) => store.toggleFilterMulti('creator', v)} onClear={() => store.clearFilterMulti('creator')} />
        <div style={{ flex: 1 }} />
        <input className={styles.search} placeholder="Buscar..." value={store.filterSearch} onChange={(e) => store.setFilterSearch(e.target.value)} />
      </div>

      {/* Bulk bar */}
      <BulkBar count={selectedCount} actions={bulkActions} onCancel={() => store.clearSelection()} />

      {/* Table */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: 32 }}><input type="checkbox" checked={pageItems.length > 0 && pageItems.every((g) => store.selectedKeys.has(g._gid))} onChange={(e) => { if (e.target.checked) store.selectAll(pageItems.map((g) => g._gid)); else store.clearSelection(); }} /></th>
              <th style={{ width: '28%' }}>Nome</th>
              <th style={{ width: 80 }}>Size</th>
              <th style={{ width: 70 }}>Formato</th>
              <th style={{ width: 180 }}>Status</th>
              <th style={{ width: 120 }}>Criado por</th>
              <th style={{ width: 110 }}>Criado em</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 && (
              <tr><td colSpan={8} className={styles.empty}>
                <div style={{ fontSize: '2rem', marginBottom: 8 }}>📋</div>
                <div>Nenhum criativo encontrado</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-tri)', marginTop: 4 }}>Criativos ativados via Tags, Surveys ou Assets aparecem aqui</div>
              </td></tr>
            )}
            {pageItems.map((g, gi) => {
              const isExpanded = store.expandedKey === g._gid;
              const dspKeys = Object.keys(g.dsps).sort() as DspType[];

              return (
                <DashboardRow
                  key={g._gid}
                  group={g}
                  dspKeys={dspKeys}
                  isExpanded={isExpanded}
                  isSelected={store.selectedKeys.has(g._gid)}
                  onToggleExpand={() => store.toggleExpand(g._gid)}
                  onToggleSelect={() => store.toggleSelect(g._gid)}
                  onEdit={() => openSingleEdit(g)}
                  delay={gi * 25}
                />
              );
            })}
          </tbody>
        </table>

        {/* Pagination */}
        <div className={styles.pagination}>
          <span>{filtered.length} criativo{filtered.length !== 1 ? 's' : ''}</span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button className={styles.pgBtn} disabled={page === 0} onClick={() => store.setPage(page - 1)}>←</button>
            <span style={{ padding: '0 10px', fontVariantNumeric: 'tabular-nums' }}>{page + 1} / {totalPages}</span>
            <button className={styles.pgBtn} disabled={page >= totalPages - 1} onClick={() => store.setPage(page + 1)}>→</button>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      <Modal visible={editVisible} onClose={() => setEditVisible(false)} title={editBulkKeys ? `Editar ${editBulkKeys.length} criativos` : 'Editar Criativo'}>
        <div className={styles.editField}>
          <label>Nome {editBulkKeys ? '(aplica a todos)' : '(aplica em todas as DSPs)'}</label>
          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={editBulkKeys ? 'Deixe vazio pra manter' : ''} />
        </div>
        {!editBulkKeys && store.editGroup && Object.entries(store.editGroup.dsps).map(([dsp, d]) => (
          <div key={dsp} className={styles.editDspSection}>
            <div className={styles.editDspHeader}>
              <span className={`${styles.dspTag} ${styles[dsp]}`}>{DSP_LABELS[dsp as DspType]}</span>
              <span className={`${styles.auditDot} ${styles[d.audit_status]}`} />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-tri)' }}>{d.audit_status}</span>
            </div>
            <div className={styles.editField}>
              <label>Landing Page URL</label>
              <input value={editFields[dsp]?.landing_page || ''} onChange={(e) => setEditFields((prev) => ({ ...prev, [dsp]: { ...prev[dsp], landing_page: e.target.value } }))} />
            </div>
            {dsp === 'xandr' && (
              <div className={styles.editField}>
                <label>Click URL</label>
                <input value={editFields[dsp]?.click_url || ''} onChange={(e) => setEditFields((prev) => ({ ...prev, [dsp]: { ...prev[dsp], click_url: e.target.value } }))} />
              </div>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className={styles.btn} onClick={() => setEditVisible(false)}>Cancelar</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSaveEdit} disabled={editSaving}>
            {editSaving ? 'Salvando...' : 'Salvar e Sincronizar'}
          </button>
        </div>
      </Modal>
    </section>
  );
}

// ── Sub-components ──

function DashboardRow({ group: g, dspKeys, isExpanded, isSelected, onToggleExpand, onToggleSelect, onEdit, delay }: {
  group: CreativeGroup; dspKeys: DspType[]; isExpanded: boolean; isSelected: boolean;
  onToggleExpand: () => void; onToggleSelect: () => void; onEdit: () => void; delay: number;
}) {
  return (
    <>
      <tr style={{ animationDelay: `${delay}ms` }} className={isExpanded ? styles.expanded : ''} onClick={onToggleExpand}>
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect()} />
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
        <td><span className={styles.formatBadge}>{getFormatLabel(g)}</span></td>
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
          <td colSpan={7}>
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

function MultiSelect({ label, values, selected, onToggle, onClear }: {
  label: string; values: string[]; selected: Set<string>;
  onToggle: (value: string) => void; onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div className={styles.ms} ref={ref}>
      <button className={`${styles.msTrigger} ${selected.size > 0 ? styles.hasSelection : ''}`} onClick={() => setOpen(!open)}>
        {label}{selected.size > 0 && <span className={styles.msBadge}>{selected.size}</span>}
        <svg viewBox="0 0 10 6" width="10" height="10" style={{ opacity: 0.5 }}><path d="M0 0l5 6 5-6z" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className={styles.msDrop}>
          {values.map((v) => (
            <div key={v} className={`${styles.msItem} ${selected.has(v) ? styles.checked : ''}`} onClick={() => onToggle(v)}>
              <span className={styles.msCb}>{selected.has(v) ? '✓' : ''}</span>
              {v}
            </div>
          ))}
          {selected.size > 0 && <div className={styles.msClear} onClick={() => { onClear(); setOpen(false); }}>Limpar filtro</div>}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatTimeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return 'agora';
  if (sec < 60) return `há ${sec}s`;
  return `há ${Math.floor(sec / 60)}min`;
}
