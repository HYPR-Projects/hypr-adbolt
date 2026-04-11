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
import { genDV360 } from '@/generators/dv360';
import { genXandr } from '@/generators/xandr';
import { genStackAdapt } from '@/generators/stackadapt';
import { genAmazonDSP } from '@/generators/amazon';
import { downloadCSV, downloadXLSX } from '@/generators/download';
import { DSP_LABELS, DSP_SHORT_LABELS } from '@/types';
import type { CreativeGroup, DspType } from '@/types';
import type { Placement } from '@/types';
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
    toast('Sincronizando status nas DSPs...', '');
    const t0 = Date.now();
    try {
      const result = await syncCreativesApi(session.access_token);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const parts: string[] = [];
      if (result.updated) parts.push(`${result.updated} atualizado${result.updated > 1 ? 's' : ''}`);
      if (result.deleted) parts.push(`${result.deleted} deletado${result.deleted > 1 ? 's' : ''}`);
      if (!result.updated && !result.deleted) parts.push('Tudo em dia');
      toast(`${parts.join(', ')} (${result.synced} verificados em ${elapsed}s)`, 'success');
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
  const partial = store.creatives.filter((c) => c.audit_status === 'partial').length;
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
    { label: 'Renomear', onClick: () => openBulkRename() },
    { label: 'Gerar Template', onClick: () => openTemplateGen() },
    { label: 'Deletar', onClick: handleBulkDelete, danger: true },
  ];

  // ── Edit modal state ──
  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editFields, setEditFields] = useState<Record<string, Record<string, string>>>({});
  const [editTrackers, setEditTrackers] = useState<Record<string, string[]>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editBulkKeys, setEditBulkKeys] = useState<string[] | null>(null);
  const [bulkLandingPage, setBulkLandingPage] = useState('');
  const [bulkTrackerRaw, setBulkTrackerRaw] = useState('');
  const [bulkTrackerMode, setBulkTrackerMode] = useState<'add' | 'replace'>('add');

  // ── Rename modal state ──
  const [renameVisible, setRenameVisible] = useState(false);
  const [renamePrefix, setRenamePrefix] = useState('');
  const [renameSuffix, setRenameSuffix] = useState('');
  const [renamePattern, setRenamePattern] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  // ── Template generator modal state ──
  const [tplVisible, setTplVisible] = useState(false);
  const [tplDsp, setTplDsp] = useState<string>('');

  const openBulkRename = () => {
    if (!store.selectedKeys.size) return;
    setRenamePrefix('');
    setRenameSuffix('');
    setRenamePattern('');
    setRenameVisible(true);
  };

  const getRenamedName = (original: string, prefix: string, suffix: string, pattern: string, index: number, dims: string, type: string): string => {
    if (pattern) {
      return pattern
        .split('{name}').join(original)
        .split('{size}').join(dims)
        .split('{type}').join(type)
        .split('{index}').join(String(index + 1));
    }
    return (prefix || '') + original + (suffix || '');
  };

  const renamePreviewItems = (() => {
    if (!renamePrefix && !renameSuffix && !renamePattern) return [];
    const keys = [...store.selectedKeys];
    return keys.slice(0, 6).map((k, i) => {
      const g = store.groups.find((g) => g._gid === k);
      if (!g) return null;
      const newName = getRenamedName(g.name, renamePrefix, renameSuffix, renamePattern, i, g.dimensions, g.creative_type);
      return { old: g.name, new: newName };
    }).filter(Boolean) as Array<{ old: string; new: string }>;
  })();

  const handleBulkRenameApply = useCallback(async () => {
    if (!session?.access_token) return;
    if (!renamePrefix && !renameSuffix && !renamePattern) { toast('Preencha pelo menos um campo', 'error'); return; }
    setRenameSaving(true);
    const token = session.access_token;
    const keys = [...store.selectedKeys];
    const groups = keys.map((k) => store.groups.find((g) => g._gid === k)).filter(Boolean) as CreativeGroup[];
    let ok = 0, fail = 0;
    const promises: Promise<void>[] = [];
    groups.forEach((g, gi) => {
      const newName = getRenamedName(g.name, renamePrefix, renameSuffix, renamePattern, gi, g.dimensions, g.creative_type);
      for (const [, d] of Object.entries(g.dsps)) {
        promises.push(
          updateCreative(token, d.id, { name: newName })
            .then(() => { ok++; })
            .catch(() => { fail++; })
        );
      }
    });
    await Promise.all(promises);
    if (!fail) toast(`${ok} nome(s) sincronizado(s)`, 'success');
    else toast(`${ok} OK, ${fail} erro(s)`, 'error');
    setRenameVisible(false);
    setRenameSaving(false);
    store.clearSelection();
    await store.loadCreatives();
  }, [session?.access_token, renamePrefix, renameSuffix, renamePattern, store.selectedKeys, store.groups, toast]);

  const openTemplateGen = () => {
    if (!store.selectedKeys.size) return;
    const keys = [...store.selectedKeys];
    const groups = store.groups.filter((g) => keys.includes(g._gid));
    const withTags = groups.filter((g) => Object.values(g.dsps).some((d) => d.js_tag || d.vast_tag));
    if (!withTags.length) { toast('Nenhum criativo selecionado possui tags 3P', 'error'); return; }
    setTplDsp('');
    setTplVisible(true);
  };

  const handleTemplateGenerate = useCallback(() => {
    if (!tplDsp) { toast('Selecione uma DSP', 'error'); return; }
    const keys = [...store.selectedKeys];
    const groups = store.groups.filter((g) => keys.includes(g._gid));
    const placements: Placement[] = [];
    for (const g of groups) {
      const dspData = Object.values(g.dsps);
      const jsTag = dspData.find((d) => d.js_tag)?.js_tag || '';
      const vastTag = dspData.find((d) => d.vast_tag)?.vast_tag || '';
      if (!jsTag && !vastTag) continue;
      const clickUrl = dspData[0]?.click_url || dspData[0]?.landing_page || '';
      const isVideo = !!vastTag && !jsTag;
      let trackers = dspData[0]?.trackers || [];
      if (typeof trackers === 'string') try { trackers = JSON.parse(trackers); } catch { trackers = []; }
      if (!Array.isArray(trackers)) trackers = [];
      placements.push({ placementId: g._gid, placementName: g.name, dimensions: g.dimensions, jsTag: jsTag || vastTag, vastTag, clickUrl, type: isVideo ? 'video' : 'display', trackers });
    }
    if (!placements.length) { toast('Nenhum criativo com tag encontrado', 'error'); return; }
    try {
      const slug = 'template_' + new Date().toISOString().slice(0, 10);
      if (tplDsp === 'dv360') {
        const f = genDV360(placements);
        downloadCSV(f.headers, f.rows, `DV360_${slug}.csv`);
      } else if (tplDsp === 'xandr') {
        const f = genXandr(placements, '', false);
        downloadXLSX(f.headers, f.rows, `Xandr_${slug}.xlsx`, { colWidths: f.colWidths });
      } else if (tplDsp === 'stackadapt') {
        const { file: f } = genStackAdapt(placements, '', '');
        downloadXLSX(f.headers, f.rows, `StackAdapt_${slug}.xlsx`, { colWidths: f.colWidths });
      } else if (tplDsp === 'amazondsp') {
        const f = genAmazonDSP(placements, '', 'BR');
        downloadXLSX(f.headers, f.rows, `AmazonDSP_${slug}.xlsx`, { colWidths: f.colWidths, sheetName: f.sheetName });
      }
      toast(`${placements.length} criativos exportados (${tplDsp.toUpperCase()})`, 'success');
      setTplVisible(false);
    } catch (err) { toast('Erro ao gerar: ' + (err as Error).message, 'error'); }
  }, [tplDsp, store.selectedKeys, store.groups, toast]);

  const openSingleEdit = (group: CreativeGroup) => {
    setEditBulkKeys(null);
    setEditName(group.name);
    const fields: Record<string, Record<string, string>> = {};
    const trackers: Record<string, string[]> = {};
    for (const [dsp, d] of Object.entries(group.dsps)) {
      fields[dsp] = {
        landing_page: d.landing_page || d.click_url || '',
        click_url: dsp === 'xandr' ? (d.click_url || '') : '',
        vast_tag: d.vast_tag || '',
      };
      let tList = d.trackers || [];
      if (typeof tList === 'string') try { tList = JSON.parse(tList); } catch { tList = []; }
      if (!Array.isArray(tList)) tList = [];
      trackers[dsp] = tList.map((t: any) => typeof t === 'string' ? t : t.url || '').filter(Boolean);
    }
    setEditFields(fields);
    setEditTrackers(trackers);
    setEditVisible(true);
    store.setEditGroup(group);
  };

  const openBulkEdit = () => {
    const keys = [...store.selectedKeys];
    setEditBulkKeys(keys);
    setEditName('');
    setEditFields({});
    setEditTrackers({});
    setBulkLandingPage('');
    setBulkTrackerRaw('');
    setBulkTrackerMode('add');
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

        // Name
        if (editName && (editBulkKeys || editName !== g.name)) changes.name = editName;

        if (editBulkKeys) {
          // Bulk mode: apply shared LP and trackers
          if (bulkLandingPage.trim()) {
            changes.landing_page = normalizeUrl(bulkLandingPage);
          }
          if (bulkTrackerRaw.trim()) {
            // Parse existing trackers for this creative
            let existingTrackers = d.trackers || [];
            if (typeof existingTrackers === 'string') try { existingTrackers = JSON.parse(existingTrackers); } catch { existingTrackers = []; }
            if (!Array.isArray(existingTrackers)) existingTrackers = [];
            const existingUrls = existingTrackers.map((t: any) => typeof t === 'string' ? t : t.url || '').filter(Boolean);

            const newUrl = normalizeUrl(bulkTrackerRaw.trim());
            if (bulkTrackerMode === 'replace') {
              changes.trackers = [newUrl];
            } else {
              if (!existingUrls.includes(newUrl)) {
                changes.trackers = [...existingUrls, newUrl];
              }
            }
          }
        } else {
          // Single mode: per-DSP fields
          const dspFields = editFields[dsp];
          if (dspFields?.landing_page !== undefined && dspFields.landing_page !== (d.landing_page || d.click_url || '')) {
            changes.landing_page = normalizeUrl(dspFields.landing_page);
          }
          if (dsp === 'xandr' && dspFields?.click_url !== undefined && dspFields.click_url !== (d.click_url || '')) {
            changes.click_url = normalizeUrl(dspFields.click_url);
          }
          if (dsp === 'dv360' && dspFields?.vast_tag !== undefined && dspFields.vast_tag !== (d.vast_tag || '')) {
            changes.vast_tag = dspFields.vast_tag;
          }
          // Trackers (compare with original)
          const newTrackerUrls = editTrackers[dsp] || [];
          let origTrackers = d.trackers || [];
          if (typeof origTrackers === 'string') try { origTrackers = JSON.parse(origTrackers); } catch { origTrackers = []; }
          if (!Array.isArray(origTrackers)) origTrackers = [];
          const origUrls = origTrackers.map((t: any) => typeof t === 'string' ? t : t.url || '').filter(Boolean);
          if (JSON.stringify(newTrackerUrls.sort()) !== JSON.stringify(origUrls.sort())) {
            changes.trackers = newTrackerUrls;
          }
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
  }, [session?.access_token, editName, editFields, editTrackers, editBulkKeys, bulkLandingPage, bulkTrackerRaw, bulkTrackerMode, store.editGroup, toast]);

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
          {store.isSyncing ? (
            <>
              <svg className={styles.spinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="14" height="14">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Sincronizando...
            </>
          ) : 'Sync Status'}
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
          <div className={styles.statTop}><div className={`${styles.statDot} ${styles.cAccent}`} /><div className={styles.statLabel}>Partial</div></div>
          <div className={styles.statVal}>{partial}</div>
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
        {['all', 'pending', 'partial', 'approved', 'rejected'].map((a) => (
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
        {store.isSyncing && <div className={styles.syncProgress}><div className={styles.syncProgressBar} /></div>}
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
      <Modal visible={editVisible} onClose={() => setEditVisible(false)} title={editBulkKeys ? `Editar ${editBulkKeys.length} criativos` : 'Editar Criativo'} maxWidth="600px">
        <div className={styles.editField}>
          <label>Nome {editBulkKeys ? '(aplica a todos)' : '(aplica em todas as DSPs)'}</label>
          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={editBulkKeys ? 'Deixe vazio pra manter' : ''} />
        </div>

        {editBulkKeys ? (
          /* ── Bulk edit: shared LP + tracker ── */
          <>
            <div className={styles.editField}>
              <label>Landing Page <span style={{ fontWeight: 400, color: 'var(--text-tri)', fontSize: '0.68rem' }}>(aplica em todos, deixe vazio pra manter)</span></label>
              <input value={bulkLandingPage} onChange={(e) => setBulkLandingPage(e.target.value)} placeholder="https://..." style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }} />
            </div>
            <div className={styles.editField}>
              <label>Impression Tracker <span style={{ fontWeight: 400, color: 'var(--text-tri)', fontSize: '0.68rem' }}>(sincroniza com as DSPs)</span></label>
              <div className={styles.bulkScopeToggle}>
                <button
                  className={`${styles.bulkScopeBtn} ${bulkTrackerMode === 'add' ? styles.bulkScopeBtnActive : ''}`}
                  onClick={() => setBulkTrackerMode('add')}
                >Adicionar aos existentes</button>
                <button
                  className={`${styles.bulkScopeBtn} ${bulkTrackerMode === 'replace' ? styles.bulkScopeBtnActive : ''}`}
                  onClick={() => setBulkTrackerMode('replace')}
                >Substituir todos</button>
              </div>
              <input
                value={bulkTrackerRaw}
                onChange={(e) => setBulkTrackerRaw(e.target.value)}
                placeholder="Cole a URL ou tag do pixel..."
                style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}
              />
            </div>
          </>
        ) : store.editGroup && Object.entries(store.editGroup.dsps).map(([dsp, d]) => (
          /* ── Single edit: per-DSP fields ── */
          <div key={dsp} className={styles.editDspSection}>
            <div className={styles.editDspHeader}>
              <span className={`${styles.dspTag} ${styles[dsp]}`}>{DSP_LABELS[dsp as DspType]}</span>
              <span className={`${styles.auditDot} ${styles[d.audit_status]}`} />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-tri)' }}>{d.audit_status}</span>
              {d.dsp_creative_id && <span style={{ fontSize: '0.68rem', color: 'var(--text-tri)', marginLeft: 'auto', fontFamily: 'var(--mono)' }}>ID: {d.dsp_creative_id}</span>}
            </div>
            <div className={styles.editField}>
              <label>Landing Page URL</label>
              <input value={editFields[dsp]?.landing_page || ''} onChange={(e) => setEditFields((prev) => ({ ...prev, [dsp]: { ...prev[dsp], landing_page: e.target.value } }))} style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }} />
            </div>
            {dsp === 'xandr' && (
              <div className={styles.editField}>
                <label>Click URL</label>
                <input value={editFields[dsp]?.click_url || ''} onChange={(e) => setEditFields((prev) => ({ ...prev, [dsp]: { ...prev[dsp], click_url: e.target.value } }))} style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }} />
              </div>
            )}
            {dsp === 'dv360' && store.editGroup?.creative_type === 'video' && (
              <div className={styles.editField}>
                <label>VAST Tag URL</label>
                <input value={editFields[dsp]?.vast_tag || ''} onChange={(e) => setEditFields((prev) => ({ ...prev, [dsp]: { ...prev[dsp], vast_tag: e.target.value } }))} style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }} />
              </div>
            )}
            <div className={styles.editField}>
              <label>Impression Trackers<span className={styles.trackerHint}>(sincroniza com a DSP ao salvar)</span></label>
              <div className={styles.trackerList}>
                {(editTrackers[dsp] || []).map((url, ti) => (
                  <div key={ti} className={styles.trackerRow}>
                    <input value={url} readOnly />
                    <button
                      className={styles.trackerRm}
                      onClick={() => {
                        setEditTrackers((prev) => ({
                          ...prev,
                          [dsp]: (prev[dsp] || []).filter((_, i) => i !== ti),
                        }));
                      }}
                      title="Remover"
                    >✕</button>
                  </div>
                ))}
              </div>
              <div className={styles.trackerAdd}>
                <input
                  id={`editTrackerNew_${dsp}`}
                  placeholder="Cole a URL do pixel..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (!val) return;
                      const url = normalizeUrl(val);
                      setEditTrackers((prev) => ({
                        ...prev,
                        [dsp]: [...(prev[dsp] || []).filter((u) => u !== url), url],
                      }));
                      (e.target as HTMLInputElement).value = '';
                    }
                  }}
                />
                <button
                  className={styles.trackerAddBtn}
                  onClick={() => {
                    const inp = document.getElementById(`editTrackerNew_${dsp}`) as HTMLInputElement;
                    const val = inp?.value.trim();
                    if (!val) return;
                    const url = normalizeUrl(val);
                    setEditTrackers((prev) => ({
                      ...prev,
                      [dsp]: [...(prev[dsp] || []).filter((u) => u !== url), url],
                    }));
                    inp.value = '';
                  }}
                >+</button>
              </div>
            </div>
            {d.sync_error && <div className={styles.syncError}>Sync error: {d.sync_error}</div>}
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className={styles.btn} onClick={() => setEditVisible(false)}>Cancelar</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSaveEdit} disabled={editSaving}>
            {editSaving ? 'Salvando...' : 'Salvar e Sincronizar'}
          </button>
        </div>
      </Modal>

      {/* Rename Modal */}
      <Modal visible={renameVisible} onClose={() => setRenameVisible(false)} title={`Renomear ${store.selectedKeys.size} criativos`}>
        <div className={styles.editField}>
          <label>Prefixo <span style={{ fontWeight: 400, color: 'var(--text-tri)' }}>(adicionado antes do nome)</span></label>
          <input value={renamePrefix} onChange={(e) => setRenamePrefix(e.target.value)} placeholder="Ex: BR_" />
        </div>
        <div className={styles.editField}>
          <label>Sufixo <span style={{ fontWeight: 400, color: 'var(--text-tri)' }}>(adicionado depois do nome)</span></label>
          <input value={renameSuffix} onChange={(e) => setRenameSuffix(e.target.value)} placeholder="Ex: _v2" />
        </div>
        <div className={styles.editField}>
          <label>Padrão completo <span style={{ fontWeight: 400, color: 'var(--text-tri)' }}>({'{name}'} {'{size}'} {'{type}'} {'{index}'})</span></label>
          <input value={renamePattern} onChange={(e) => setRenamePattern(e.target.value)} placeholder="Ex: HYPR_{name}_{size}" style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }} />
        </div>
        {renamePreviewItems.length > 0 && (
          <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-base)', borderRadius: 'var(--r-xs)', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-tri)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Preview</div>
            {renamePreviewItems.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.75rem', padding: '3px 0', fontFamily: 'var(--mono)' }}>
                <span style={{ color: 'var(--text-tri)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.old}</span>
                <span style={{ color: 'var(--text-tri)', flexShrink: 0 }}>→</span>
                <span style={{ color: 'var(--accent)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.new}</span>
              </div>
            ))}
            {store.selectedKeys.size > 6 && <div style={{ fontSize: '0.68rem', color: 'var(--text-tri)', marginTop: 4 }}>...e mais {store.selectedKeys.size - 6}</div>}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className={styles.btn} onClick={() => setRenameVisible(false)}>Cancelar</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleBulkRenameApply} disabled={renameSaving || (!renamePrefix && !renameSuffix && !renamePattern)}>
            {renameSaving ? 'Renomeando...' : 'Aplicar e Sincronizar'}
          </button>
        </div>
      </Modal>

      {/* Template Generator Modal */}
      <Modal visible={tplVisible} onClose={() => setTplVisible(false)} title="Gerar Template">
        <div style={{ fontSize: '0.82rem', color: 'var(--text-sec)', marginBottom: 16 }}>
          {store.selectedKeys.size} criativo(s) selecionado(s) com tags. Selecione a DSP de destino:
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {[
            { id: 'xandr', icon: 'XN', name: 'Xandr', desc: 'Bulk XLSX' },
            { id: 'dv360', icon: 'DV', name: 'DV360', desc: 'Bulk CSV' },
            { id: 'stackadapt', icon: 'SA', name: 'StackAdapt', desc: 'Bulk XLSX' },
            { id: 'amazondsp', icon: 'AZ', name: 'Amazon DSP', desc: 'XLSX' },
          ].map((d) => (
            <div
              key={d.id}
              onClick={() => setTplDsp(d.id)}
              style={{
                padding: '14px 16px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                border: `1.5px solid ${tplDsp === d.id ? 'var(--accent)' : 'var(--border)'}`,
                background: tplDsp === d.id ? 'var(--accent-dim)' : 'var(--bg-surface)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{d.icon} {d.name}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-tri)', marginTop: 2 }}>{d.desc}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className={styles.btn} onClick={() => setTplVisible(false)}>Cancelar</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleTemplateGenerate} disabled={!tplDsp}>
            Gerar e Baixar
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
