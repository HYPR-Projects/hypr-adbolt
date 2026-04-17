import { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { useDashboardStore, getFormatLabel } from '@/stores/dashboard';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { useColumnResize } from '@/hooks/useColumnResize';
import { BulkBar } from '@/components/shared/BulkBar';
import { Modal } from '@/components/shared/Modal';
import { syncCreatives as syncCreativesApi } from '@/services/sync';
import { updateCreative } from '@/services/update';
import { deleteCreatives } from '@/services/delete';
import { normalizeUrl, getRenamedName } from '@/lib/utils';
import { genDV360 } from '@/generators/dv360';
import { genXandr } from '@/generators/xandr';
import { genStackAdapt } from '@/generators/stackadapt';
import { genAmazonDSP } from '@/generators/amazon';
import { downloadCSV, downloadXLSX } from '@/generators/download';
import { DSP_LABELS } from '@/types';
import type { CreativeGroup, DspType } from '@/types';
import type { Placement } from '@/types';
import { DashboardRow } from './DashboardRow';
import { CreativePreviewModal } from '@/components/shared/CreativePreview';
import { MultiSelect } from './MultiSelect';
import { formatTimeAgo } from './helpers';
import styles from './Dashboard.module.css';
import { DateFilter } from './DateFilter';

export function Dashboard() {
  const store = useDashboardStore();
  const session = useAuthStore((s) => s.session);
  const toast = useUIStore((s) => s.toast);

  const autoSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Column resize ──
  const DASH_COLUMNS = useMemo(() => [
    { key: 'cb',      minWidth: 32,  defaultWidth: 32,  resizable: false },
    { key: 'thumb',   minWidth: 40,  defaultWidth: 40,  resizable: false },
    { key: 'name',    minWidth: 140, defaultWidth: 300 },
    { key: 'size',    minWidth: 60,  defaultWidth: 80 },
    { key: 'format',  minWidth: 55,  defaultWidth: 70 },
    { key: 'status',  minWidth: 100, defaultWidth: 180 },
    { key: 'creator', minWidth: 80,  defaultWidth: 120 },
    { key: 'date',    minWidth: 80,  defaultWidth: 110 },
    { key: 'actions', minWidth: 50,  defaultWidth: 60,  resizable: false },
  ], []);
  const { headerProps, ResizeHandle, tableStyle } = useColumnResize({
    storageKey: 'dashboard-table-v2',
    columns: DASH_COLUMNS,
  });

  // Debounced search to avoid filtering on every keystroke
  const [searchInput, setSearchInput] = useState(store.filterSearch);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => store.setFilterSearch(value), 250);
  }, []);

  // Load on mount — runs once + reload when tab becomes visible
  useEffect(() => {
    store.loadCreatives();
    // Auto-sync every 5 min
    autoSyncRef.current = setInterval(() => silentSync(), 300000);

    // Reload data when tab becomes visible (user may have activated from another tab)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        store.loadCreatives();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (autoSyncRef.current) clearInterval(autoSyncRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Keyboard pagination (←/→ when no input is focused)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') store.setPage(Math.max(0, store.page - 1));
      else if (e.key === 'ArrowRight') {
        const maxPage = Math.ceil(store.getFilteredGroups().length / store.pageSize) - 1;
        store.setPage(Math.min(maxPage, store.page + 1));
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const silentSync = useCallback(async () => {
    if (store.isSyncing || !session?.access_token) return;
    const hasPending = store.creatives.some((c) => c.audit_status !== 'approved');
    if (!hasPending && store.creatives.length > 0) return;
    store.setSyncing(true);
    try {
      await syncCreativesApi(session.access_token, 'pending');
      await store.loadCreatives();
    } catch (e) { console.warn('silent sync error:', e); }
    finally { store.setSyncing(false); }
  }, [session?.access_token, store.creatives.length]);

  const handleSync = useCallback(async () => {
    if (!session?.access_token) return;
    store.setSyncing(true);
    const total = store.creatives.length;
    toast(`Verificando ${total} registros nas DSPs...`, '');
    const t0 = Date.now();
    try {
      const result = await syncCreativesApi(session.access_token, 'full');
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const parts: string[] = [];
      if (result.updated) parts.push(`${result.updated} atualizado${result.updated > 1 ? 's' : ''}`);
      if (result.deleted) parts.push(`${result.deleted} deletado${result.deleted > 1 ? 's' : ''}`);
      if (!result.updated && !result.deleted) parts.push('Tudo em dia');
      toast(`${parts.join(', ')} (${result.synced} verificados em ${elapsed}s)`, 'success');
      await store.loadCreatives();
    } catch (err) { toast('Erro no sync: ' + (err as Error).message, 'error'); }
    finally { store.setSyncing(false); }
  }, [session?.access_token, toast, store.creatives.length]);

  // ── Filtered data (memoized to avoid recalc on every render) ──
  const filtered = useMemo(
    () => store.getFilteredGroups(),
    [store.groups, store.filterDsp, store.filterAudit, store.filterSize, store.filterFormat, store.filterCreator, store.filterSearch, store.filterDateFrom, store.filterDateTo],
  );
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
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState('');
  const [deleteDspFilter, setDeleteDspFilter] = useState<Set<string>>(new Set());

  // Compute DSP breakdown for selected groups
  const deleteBreakdown = (() => {
    if (!deleteConfirmVisible) return { dsps: {} as Record<string, number>, total: 0 };
    const keys = [...store.selectedKeys];
    const groups = keys.map((k) => store.groups.find((g) => g._gid === k)).filter(Boolean) as CreativeGroup[];
    const dsps: Record<string, number> = {};
    groups.forEach((g) => Object.keys(g.dsps).forEach((dsp) => { dsps[dsp] = (dsps[dsp] || 0) + 1; }));
    const total = Object.entries(dsps).reduce((sum, [dsp, count]) => sum + (deleteDspFilter.size === 0 || deleteDspFilter.has(dsp) ? count : 0), 0);
    return { dsps, total };
  })();

  const handleBulkDelete = useCallback(() => {
    if (!selectedCount) return;
    setDeleteDspFilter(new Set());
    setDeleteConfirmVisible(true);
  }, [selectedCount]);

  const executeDelete = useCallback(async () => {
    if (!session?.access_token) return;
    setDeleteConfirmVisible(false);
    setIsDeleting(true);

    const keys = [...store.selectedKeys];
    const groups = keys.map((k) => store.groups.find((g) => g._gid === k)).filter(Boolean) as CreativeGroup[];
    const allIds: string[] = [];
    groups.forEach((g) => {
      Object.entries(g.dsps).forEach(([dsp, d]) => {
        // If no DSP filter set, delete all; otherwise only selected DSPs
        if (deleteDspFilter.size === 0 || deleteDspFilter.has(dsp)) {
          allIds.push(d.id);
        }
      });
    });

    if (!allIds.length) {
      toast('Nenhum criativo selecionado para deletar', 'error');
      setIsDeleting(false);
      return;
    }

    try {
      const CHUNK = 20;
      let totalDeleted = 0, totalArchived = 0, totalFailed = 0;
      for (let i = 0; i < allIds.length; i += CHUNK) {
        const chunk = allIds.slice(i, i + CHUNK);
        setDeleteProgress(`Processando ${Math.min(i + CHUNK, allIds.length)}/${allIds.length}...`);
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
    finally { setIsDeleting(false); setDeleteProgress(''); }
  }, [session?.access_token, store.selectedKeys, store.groups, toast, deleteDspFilter]);

  const bulkActions = [
    { label: 'Editar', onClick: () => openBulkEdit() },
    { label: 'Renomear', onClick: () => openBulkRename() },
    { label: 'Gerar Template', onClick: () => openTemplateGen() },
    { label: 'Deletar', onClick: handleBulkDelete, danger: true },
  ];

  // ── Preview state ──
  const [previewData, setPreviewData] = useState<{
    name: string; dimensions: string;
    type: 'display' | 'video' | 'html5' | '3p-tag' | 'survey';
    imageUrl?: string; videoUrl?: string; tagContent?: string;
    html5Content?: string; html5Url?: string; mimeType?: string; thumbUrl?: string; vastTagUrl?: string;
    dv360CreativeId?: string; dv360AdvertiserId?: string;
  } | null>(null);

  const openPreview = useCallback(async (g: CreativeGroup) => {
    const isHtml5 = g.asset_filename?.toLowerCase().endsWith('.zip') || g.asset_mime_type?.includes('zip');
    const isVideo = g.creative_type === 'video';
    const isAsset = !!g.asset_filename && !isHtml5;
    const base = { name: g.name, dimensions: g.dimensions };

    // HTML5 with preview URL stored in js_tag
    if (isHtml5) {
      const previewUrl = g.js_tag?.startsWith('http') ? g.js_tag
        : Object.values(g.dsps).find(d => d.js_tag?.startsWith('http'))?.js_tag;
      if (previewUrl) {
        setPreviewData({ ...base, type: 'html5', html5Url: previewUrl, thumbUrl: g.thumbnail_url || undefined });
        return;
      }
      if (g.thumbnail_url) {
        setPreviewData({ ...base, type: 'display', imageUrl: g.thumbnail_url, thumbUrl: g.thumbnail_url });
        return;
      }
      setPreviewData({ ...base, type: 'html5' });
      return;
    }

    // VAST tag placeholder
    const dspWithVast = Object.values(g.dsps).find(d => d.vast_tag);
    if (isVideo && dspWithVast?.vast_tag) {
      setPreviewData({
        ...base, type: 'video',
        vastTagUrl: dspWithVast.vast_tag,
      });
      return;
    }

    // Asset (image/GIF/video) — try signed URL from storage_path in dsp_config
    if (isAsset) {
      const storagePath = (() => {
        for (const d of Object.values(g.dsps)) {
          const cfg = (typeof d.dsp_config === 'string' ? JSON.parse(d.dsp_config || '{}') : d.dsp_config) || {};
          if (cfg.storage_path) return cfg.storage_path as string;
        }
        return null;
      })();

      if (storagePath) {
        // Show thumb immediately while signed URL loads
        if (g.thumbnail_url) {
          setPreviewData({ ...base, type: isVideo ? 'video' : 'display', imageUrl: g.thumbnail_url, mimeType: g.asset_mime_type || undefined });
        }
        try {
          const { supabase } = await import('@/services/supabase');
          const { data } = await supabase.storage.from('asset-uploads').createSignedUrl(storagePath, 3600);
          if (data?.signedUrl) {
            if (isVideo) {
              setPreviewData({ ...base, type: 'video', videoUrl: data.signedUrl, thumbUrl: g.thumbnail_url || undefined });
            } else {
              setPreviewData({ ...base, type: 'display', imageUrl: data.signedUrl, mimeType: g.asset_mime_type || undefined });
            }
            return;
          }
        } catch (err) {
          console.warn('Signed URL failed:', err);
        }
      }
    }

    // Has thumbnail → fallback
    if (g.thumbnail_url) {
      setPreviewData({ ...base, type: 'display', imageUrl: g.thumbnail_url, mimeType: g.asset_mime_type || undefined });
      return;
    }

    // 3P tag with js_tag content
    const tagContent = (g.js_tag && !g.js_tag.startsWith('http')) ? g.js_tag
      : Object.values(g.dsps).find(d => d.js_tag && !d.js_tag.startsWith('http'))?.js_tag;
    if (tagContent) {
      const isSurvey = tagContent.includes('form.typeform.com');
      // Pull DV360 creative + advertiser ids so the preview can offer a
      // "Ver no DV360" escape hatch — DCM tags only render on whitelisted
      // domains (displayvideo.google.com), so a direct DSP link is the only
      // reliable way to visually verify the creative.
      const dv360Dsp = g.dsps.dv360;
      const dv360Cfg = (typeof dv360Dsp?.dsp_config === 'string'
        ? JSON.parse(dv360Dsp.dsp_config || '{}')
        : dv360Dsp?.dsp_config) || {};
      setPreviewData({
        ...base,
        type: isSurvey ? 'survey' : '3p-tag',
        tagContent,
        dv360CreativeId: dv360Dsp?.dsp_creative_id || undefined,
        dv360AdvertiserId: (dv360Cfg as { advertiser_id?: string }).advertiser_id,
      });
      return;
    }

    setPreviewData({ ...base, type: 'display' });
  }, []);

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


  const renamePreviewItems = (() => {
    if (!renamePrefix && !renameSuffix && !renamePattern) return [];
    const keys = [...store.selectedKeys];
    return keys.slice(0, 6).map((k, i) => {
      const g = store.groups.find((g) => g._gid === k);
      if (!g) return null;
      const newName = getRenamedName(g.name, renamePrefix, renameSuffix, renamePattern, i, { dimensions: g.dimensions, type: g.creative_type });
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
      const newName = getRenamedName(g.name, renamePrefix, renameSuffix, renamePattern, gi, { dimensions: g.dimensions, type: g.creative_type });
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

    // Snapshot editTrackers and auto-include any pending input text
    const trackerSnapshot: Record<string, string[]> = { ...editTrackers };
    if (!editBulkKeys && store.editGroup) {
      for (const dsp of Object.keys(store.editGroup.dsps)) {
        const inp = document.getElementById(`editTrackerNew_${dsp}`) as HTMLInputElement;
        if (inp?.value.trim()) {
          const url = normalizeUrl(inp.value.trim());
          if (!trackerSnapshot[dsp]) trackerSnapshot[dsp] = [];
          if (!trackerSnapshot[dsp].includes(url)) trackerSnapshot[dsp] = [...trackerSnapshot[dsp], url];
        }
      }
    }

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
          // Trackers (compare with original, using snapshot that includes pending input)
          const newTrackerUrls = trackerSnapshot[dsp] || [];
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
              {store.creatives.length} registros...
            </>
          ) : 'Sync Status'}
        </button>
      </div>

      {/* Stats */}
      <div className={styles.stats}>
        <div
          className={`${styles.stat} ${styles.statHero} ${store.filterAudit === 'all' ? styles.statActive : ''}`}
          onClick={() => store.setFilterAudit('all')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') store.setFilterAudit('all'); }}
        >
          <div className={styles.statVal}>{totalGroups}</div>
          <div className={styles.statLabel}>Criativos</div>
        </div>
        {([
          { key: 'approved', color: 'cSuccess', label: 'Approved', value: approved },
          { key: 'partial', color: 'cAccent', label: 'Partial', value: partial },
          { key: 'pending', color: 'cWarning', label: 'Pending', value: pending },
          { key: 'rejected', color: 'cError', label: 'Rejected', value: rejected },
        ] as const).map((s) => (
          <div
            key={s.key}
            className={`${styles.stat} ${store.filterAudit === s.key ? styles.statActive : ''}`}
            onClick={() => store.setFilterAudit(store.filterAudit === s.key ? 'all' : s.key)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') store.setFilterAudit(store.filterAudit === s.key ? 'all' : s.key); }}
          >
            <div className={styles.statTop}><div className={`${styles.statDot} ${styles[s.color]}`} /><div className={styles.statLabel}>{s.label}</div></div>
            <div className={styles.statVal}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Truncation warning */}
      {store.isTruncated && (
        <div style={{
          padding: '8px 16px', margin: '0 0 8px', borderRadius: 'var(--r-xs)',
          background: 'var(--warning-dim, rgba(186,117,23,0.1))',
          color: 'var(--warning, #BA7517)',
          fontSize: 'var(--fs-xs)', fontWeight: 500,
        }}>
          Mostrando os 2.000 registros mais recentes. Criativos mais antigos não aparecem nesta listagem.
        </div>
      )}

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
            {a === 'all' ? 'Todos' : a.charAt(0).toUpperCase() + a.slice(1)}
          </button>
        ))}
        <span className={styles.divider} />
        <MultiSelect label="Size" values={allSizes} selected={store.filterSize} onToggle={(v) => store.toggleFilterMulti('size', v)} onClear={() => store.clearFilterMulti('size')} />
        <MultiSelect label="Formato" values={allFormats} selected={store.filterFormat} onToggle={(v) => store.toggleFilterMulti('format', v)} onClear={() => store.clearFilterMulti('format')} />
        <MultiSelect label="Criador" values={allCreators} selected={store.filterCreator} onToggle={(v) => store.toggleFilterMulti('creator', v)} onClear={() => store.clearFilterMulti('creator')} />
        <DateFilter
          from={store.filterDateFrom}
          to={store.filterDateTo}
          onChange={(from, to) => store.setFilterDate(from, to)}
        />
        <div style={{ flex: 1 }} />
        <input className={styles.search} placeholder="Buscar..." value={searchInput} onChange={(e) => handleSearchChange(e.target.value)} />
      </div>

      {/* Bulk bar */}
      <BulkBar count={selectedCount} actions={bulkActions} onCancel={() => store.clearSelection()} />

      {/* Table */}
      <div className={styles.tableWrap}>
        {store.isSyncing && <div className={styles.syncProgress}><div className={styles.syncProgressBar} /></div>}
        <table className={styles.table} style={tableStyle}>
          <thead>
            <tr>
              <th {...headerProps(0)}><input type="checkbox" checked={pageItems.length > 0 && pageItems.every((g) => store.selectedKeys.has(g._gid))} onChange={(e) => { if (e.target.checked) store.selectAll(pageItems.map((g) => g._gid)); else store.clearSelection(); }} /></th>
              <th {...headerProps(1)}></th>
              <th {...headerProps(2)}>Nome<ResizeHandle colIdx={2} /></th>
              <th {...headerProps(3)}>Size<ResizeHandle colIdx={3} /></th>
              <th {...headerProps(4)}>Formato<ResizeHandle colIdx={4} /></th>
              <th {...headerProps(5)}>Status<ResizeHandle colIdx={5} /></th>
              <th {...headerProps(6)}>Criado por<ResizeHandle colIdx={6} /></th>
              <th {...headerProps(7)}>Criado em<ResizeHandle colIdx={7} /></th>
              <th {...headerProps(8)}></th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 && (
              <tr><td colSpan={9} className={styles.empty}>
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
                  onPreview={() => openPreview(g)}
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
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (!val) return;
                    const url = normalizeUrl(val);
                    setEditTrackers((prev) => ({
                      ...prev,
                      [dsp]: [...(prev[dsp] || []).filter((u) => u !== url), url],
                    }));
                    e.target.value = '';
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

      <CreativePreviewModal
        data={previewData}
        onClose={() => setPreviewData(null)}
      />

      {/* Delete confirmation modal */}
      <Modal visible={deleteConfirmVisible} onClose={() => setDeleteConfirmVisible(false)} title="Confirmar exclusão" maxWidth="460px">
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-sec)', lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 16px' }}><strong>{selectedCount}</strong> grupo(s) selecionado(s). Escolha de quais DSPs deseja remover:</p>

          {/* DSP selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              className={styles.btn}
              style={{
                flex: 1, padding: '10px 12px', textAlign: 'center',
                background: deleteDspFilter.size === 0 ? 'var(--accent-dim)' : 'var(--bg-surface)',
                borderColor: deleteDspFilter.size === 0 ? 'var(--accent)' : 'var(--border)',
                fontWeight: deleteDspFilter.size === 0 ? 600 : 400,
              }}
              onClick={() => setDeleteDspFilter(new Set())}
            >
              Todas DSPs
            </button>
            {Object.entries(deleteBreakdown.dsps).map(([dsp, count]) => {
              const active = deleteDspFilter.has(dsp);
              return (
                <button
                  key={dsp}
                  className={styles.btn}
                  style={{
                    flex: 1, padding: '10px 12px', textAlign: 'center',
                    background: active ? 'var(--accent-dim)' : 'var(--bg-surface)',
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    fontWeight: active ? 600 : 400,
                  }}
                  onClick={() => {
                    const next = new Set(deleteDspFilter);
                    if (active) { next.delete(dsp); } else { next.add(dsp); }
                    setDeleteDspFilter(next);
                  }}
                >
                  <div>{DSP_LABELS[dsp as DspType] || dsp}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', fontWeight: 400 }}>{count} registro(s)</div>
                </button>
              );
            })}
          </div>

          {/* Summary */}
          <div style={{ padding: '10px 14px', borderRadius: 'var(--r-xs)', background: 'var(--bg-base)', marginBottom: 12 }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)' }}>
              {deleteBreakdown.total} registro(s) serão removidos
              {deleteDspFilter.size > 0 && ` (apenas ${[...deleteDspFilter].map(d => DSP_LABELS[d as DspType] || d).join(' e ')})`}
            </div>
            {(deleteDspFilter.size === 0 || deleteDspFilter.has('xandr')) && deleteBreakdown.dsps['xandr'] && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', marginTop: 4 }}>Xandr — deletados permanentemente</div>
            )}
            {(deleteDspFilter.size === 0 || deleteDspFilter.has('dv360')) && deleteBreakdown.dsps['dv360'] && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', marginTop: 2 }}>DV360 — arquivados</div>
            )}
          </div>

          <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--error)' }}>Essa ação não pode ser desfeita.</p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className={styles.btn} onClick={() => setDeleteConfirmVisible(false)}>Cancelar</button>
          <button
            className={styles.btn}
            style={{ background: 'var(--error)', color: '#fff', borderColor: 'var(--error)' }}
            onClick={executeDelete}
            disabled={deleteBreakdown.total === 0}
          >
            Deletar {deleteBreakdown.total > 0 ? `(${deleteBreakdown.total})` : ''}
          </button>
        </div>
      </Modal>

      {/* Delete loading overlay */}
      {isDeleting && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 150,
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'fadeIn 0.2s var(--ease-out)',
        }}>
          <div style={{
            background: 'var(--bg-surface)', border: 'var(--surface-border) solid var(--border)',
            borderRadius: 'var(--surface-radius)', padding: '32px 40px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
            boxShadow: 'var(--shadow-lg)', minWidth: 260,
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 0.8s linear infinite' }}>
              <path d="M21 12a9 9 0 11-6.219-8.56" />
            </svg>
            <div style={{ fontSize: 'var(--fs-base)', fontWeight: 500, color: 'var(--text)' }}>Deletando criativos...</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tri)', fontFamily: 'var(--mono)' }}>{deleteProgress}</div>
          </div>
        </div>
      )}
    </section>
  );
}