import { create } from 'zustand';
import type { Creative, CreativeGroup, DspDetail, AuditStatus } from '@/types';
import { supabase } from '@/services/supabase';

interface DashboardState {
  // ── Data ──
  creatives: Creative[];
  groups: CreativeGroup[];
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncTime: number | null;

  // ── Filters ──
  filterDsp: string; // 'all' | DspType
  filterAudit: string; // 'all' | AuditStatus
  filterSearch: string;
  filterSize: Set<string>;
  filterFormat: Set<string>;
  filterCreator: Set<string>;

  // ── Pagination ──
  page: number;
  pageSize: number;

  // ── Selection ──
  selectedKeys: Set<string>;
  expandedKey: string | null;

  // ── Edit modal ──
  editGroup: CreativeGroup | null;
  editBulkKeys: string[] | null;

  // ── Actions ──
  loadCreatives: () => Promise<void>;
  setFilterDsp: (dsp: string) => void;
  setFilterAudit: (audit: string) => void;
  setFilterSearch: (search: string) => void;
  toggleFilterMulti: (filterId: 'size' | 'format' | 'creator', value: string) => void;
  clearFilterMulti: (filterId: 'size' | 'format' | 'creator') => void;
  setPage: (page: number) => void;
  toggleSelect: (key: string) => void;
  selectAll: (keys: string[]) => void;
  clearSelection: () => void;
  toggleExpand: (key: string) => void;
  setEditGroup: (group: CreativeGroup | null, bulkKeys?: string[]) => void;
  setSyncing: (v: boolean) => void;
  setLastSyncTime: (t: number) => void;

  // ── Computed ──
  getFilteredGroups: () => CreativeGroup[];
  getPendingCount: () => number;
}

function buildGroups(creatives: Creative[]): CreativeGroup[] {
  // Sort oldest first so we build groups chronologically
  const sorted = [...creatives].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const groups: CreativeGroup[] = [];
  // Map from name||dimensions to array of groups (multiple groups possible for same name)
  const groupsByKey = new Map<string, CreativeGroup[]>();

  for (const c of sorted) {
    const key = c.name + '||' + c.dimensions;
    const existing = groupsByKey.get(key) || [];

    // Find a group that doesn't already have this DSP
    let g = existing.find((g) => !g.dsps[c.dsp]);

    if (!g) {
      // No group available (either none exist, or all already have this DSP) → create new
      g = {
        _gid: '',
        name: c.name,
        dimensions: c.dimensions || '',
        creative_type: c.creative_type,
        asset_filename: c.asset_filename || null,
        asset_mime_type: c.asset_mime_type || null,
        thumbnail_url: c.thumbnail_url || null,
        js_tag: c.js_tag || null,
        created_by_name: c.created_by_name || c.created_by_email || '-',
        created_at: c.created_at,
        last_edited_at: c.last_synced_at || c.updated_at || null,
        last_edited_by: c.last_edited_by_name || null,
        dsps: {},
      };
      groups.push(g);
      existing.push(g);
      groupsByKey.set(key, existing);
    }

    const dspConfig = typeof c.dsp_config === 'string'
      ? JSON.parse(c.dsp_config || '{}')
      : (c.dsp_config || {});

    const trackers = typeof c.trackers === 'string'
      ? (() => { try { return JSON.parse(c.trackers); } catch { return []; } })()
      : (c.trackers || []);

    g.dsps[c.dsp] = {
      id: c.id,
      dsp_creative_id: c.dsp_creative_id,
      audit_status: (c.audit_status as AuditStatus) || 'unknown',
      click_url: c.click_url,
      landing_page: c.landing_page,
      js_tag: c.js_tag,
      vast_tag: c.vast_tag,
      sync_error: c.sync_error,
      dsp_config: dspConfig,
      trackers,
    };

    if (new Date(c.created_at) < new Date(g.created_at)) {
      g.created_at = c.created_at;
    }

    // Propagate thumbnail from any creative that has one
    if (!g.thumbnail_url && c.thumbnail_url) {
      g.thumbnail_url = c.thumbnail_url;
    }
    // Also propagate js_tag if not set
    if (!g.js_tag && c.js_tag) {
      g.js_tag = c.js_tag;
    }

    const editTs = c.last_synced_at || c.updated_at;
    if (editTs && (!g.last_edited_at || new Date(editTs) > new Date(g.last_edited_at))) {
      g.last_edited_at = editTs;
      g.last_edited_by = c.last_edited_by_name || null;
    }
  }

  // Sort by created_at descending, assign stable IDs
  groups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  groups.forEach((g, i) => {
    g._gid = 'g' + i + '_' + g.name.substring(0, 10) + '_' + g.dimensions;
  });

  return groups;
}

function getFormatLabel(g: CreativeGroup): string {
  if (g.asset_filename) {
    const ext = g.asset_filename.split('.').pop()?.toUpperCase() || '';
    if (ext === 'ZIP') return 'HTML5';
    return ext;
  }
  if (g.asset_mime_type) {
    const mt = g.asset_mime_type;
    if (mt.includes('jpeg') || mt.includes('jpg')) return 'JPG';
    if (mt.includes('png')) return 'PNG';
    if (mt.includes('gif')) return 'GIF';
    if (mt.includes('mp4')) return 'MP4';
    if (mt.includes('webm')) return 'WEBM';
    if (mt.includes('mov') || mt.includes('quicktime')) return 'MOV';
    if (mt.includes('zip')) return 'HTML5';
  }
  if (g.creative_type === 'video') return 'VAST';
  return '3P Tag';
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  creatives: [],
  groups: [],
  isLoading: false,
  isSyncing: false,
  lastSyncTime: null,
  filterDsp: 'all',
  filterAudit: 'all',
  filterSearch: '',
  filterSize: new Set(),
  filterFormat: new Set(),
  filterCreator: new Set(),
  page: 0,
  pageSize: 50,
  selectedKeys: new Set(),
  expandedKey: null,
  editGroup: null,
  editBulkKeys: null,

  loadCreatives: async () => {
    set({ isLoading: true });
    try {
      const { data, error } = await supabase
        .from('creatives')
        .select('*')
        .neq('status', 'deleted')
        .order('created_at', { ascending: false })
        .limit(2000);

      if (error) throw error;

      const creatives = (data || []) as Creative[];
      const groups = buildGroups(creatives);

      set({ creatives, groups, isLoading: false, lastSyncTime: Date.now() });
    } catch (err) {
      console.error('loadCreatives error:', err);
      set({ isLoading: false });
    }
  },

  setFilterDsp: (dsp) => set({ filterDsp: dsp, page: 0, expandedKey: null }),
  setFilterAudit: (audit) => set({ filterAudit: audit, page: 0, expandedKey: null }),
  setFilterSearch: (search) => set({ filterSearch: search.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(), page: 0, expandedKey: null }),

  toggleFilterMulti: (filterId, value) => {
    const map = { size: 'filterSize', format: 'filterFormat', creator: 'filterCreator' } as const;
    const key = map[filterId];
    const current = get()[key];
    const next = new Set(current);
    if (next.has(value)) next.delete(value); else next.add(value);
    set({ [key]: next, page: 0, expandedKey: null } as Partial<DashboardState>);
  },

  clearFilterMulti: (filterId) => {
    const map = { size: 'filterSize', format: 'filterFormat', creator: 'filterCreator' } as const;
    set({ [map[filterId]]: new Set(), page: 0, expandedKey: null } as Partial<DashboardState>);
  },

  setPage: (page) => set({ page, expandedKey: null }),

  toggleSelect: (key) => {
    const next = new Set(get().selectedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    set({ selectedKeys: next });
  },

  selectAll: (keys) => set({ selectedKeys: new Set(keys) }),

  clearSelection: () => set({ selectedKeys: new Set() }),

  toggleExpand: (key) => {
    set((s) => ({ expandedKey: s.expandedKey === key ? null : key }));
  },

  setEditGroup: (group, bulkKeys) => set({ editGroup: group, editBulkKeys: bulkKeys || null }),

  setSyncing: (v) => set({ isSyncing: v }),
  setLastSyncTime: (t) => set({ lastSyncTime: t }),

  getFilteredGroups: () => {
    const s = get();
    let list = s.groups;

    if (s.filterDsp !== 'all') {
      list = list.filter((g) => g.dsps[s.filterDsp]);
    }
    if (s.filterAudit !== 'all') {
      list = list.filter((g) =>
        Object.values(g.dsps).some((d: DspDetail) => d.audit_status === s.filterAudit)
      );
    }
    if (s.filterSize.size) {
      list = list.filter((g) => s.filterSize.has(g.dimensions));
    }
    if (s.filterFormat.size) {
      list = list.filter((g) => s.filterFormat.has(getFormatLabel(g)));
    }
    if (s.filterCreator.size) {
      list = list.filter((g) => s.filterCreator.has(g.created_by_name));
    }
    if (s.filterSearch) {
      list = list.filter((g) => g.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(s.filterSearch));
    }

    return list;
  },

  getPendingCount: () => {
    return get().creatives.filter((c) => c.audit_status === 'pending').length;
  },
}));

// Re-export for dashboard components
export { getFormatLabel };
