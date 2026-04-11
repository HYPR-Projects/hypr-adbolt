import { create } from 'zustand';
import type {
  WizardMode, DspType, ParsedData, AssetEntry, SurveyEntry,
  Placement, Tracker, ActivationResult,
} from '@/types';
import { WIZARD_CONFIGS } from '@/types';
import { DSP_DEFAULTS } from '@/lib/dsp-config';
import { normalizeUrl } from '@/lib/utils';

interface WizardState {
  // ── Mode & Navigation ──
  mode: WizardMode;
  currentStep: number;

  // ── Tags mode ──
  parsedData: ParsedData | null;
  selectedTagIds: Set<number>;
  tagsFilterType: 'all' | 'display' | 'video';
  tagsFilterSize: string;
  tagsFilterText: string;

  // ── Assets mode ──
  assetEntries: AssetEntry[];
  assetIdCounter: number;
  selectedAssetIds: Set<number>;
  assetsFilterType: 'all' | 'display' | 'video';
  assetsFilterSize: string;
  assetsFilterText: string;

  // ── Surveys mode ──
  surveyEntries: SurveyEntry[];
  surveyIdCounter: number;

  // ── DSP selection ──
  selectedDsps: Set<DspType>;

  // ── Config ──
  brand: string;
  isPolitical: boolean;
  xandrLangId: number;
  xandrBrandId: string;
  xandrBrandUrl: string;
  xandrSla: number;
  dv360AdvId: string;
  amazonAdvId: string;
  amazonMarketplace: string;

  // ── Activation ──
  generatedFiles: Record<string, unknown>;
  activationDone: boolean;
  activating: boolean;
  activationResults: ActivationResult[];

  // ── Actions ──
  enterWizard: (mode: WizardMode) => void;
  resetWizard: () => void;
  setStep: (step: number) => void;

  // Tags
  setParsedData: (data: ParsedData | null) => void;
  mergeParsedData: (newData: ParsedData) => { added: number; skipped: number };
  removeTagPlacements: (indices: number[]) => void;
  setTagsFilter: (filter: Partial<{ type: 'all' | 'display' | 'video'; size: string; text: string }>) => void;
  toggleTagSelection: (idx: number) => void;
  selectAllTags: (filtered: number[]) => void;
  clearTagSelection: () => void;
  updatePlacement: (idx: number, field: keyof Placement, value: string) => void;
  addPlacementTracker: (idx: number, tracker: Tracker) => void;
  removePlacementTracker: (idx: number, trackerIdx: number) => void;

  // Assets
  addAssetEntries: (entries: AssetEntry[]) => void;
  removeAsset: (id: number) => void;
  updateAsset: (id: number, updates: Partial<AssetEntry>) => void;
  duplicateAsset: (id: number) => void;
  toggleAssetSelection: (id: number) => void;
  selectAllAssets: (filtered: number[]) => void;
  clearAssetSelection: () => void;
  setAssetsFilter: (filter: Partial<{ type: 'all' | 'display' | 'video'; size: string; text: string }>) => void;
  addAssetTracker: (id: number, tracker: Tracker) => void;
  removeAssetTracker: (id: number, trackerIdx: number) => void;
  getNextAssetId: () => number;

  // Surveys
  addSurveyEntry: (type: string) => void;
  removeSurveyEntry: (id: number) => void;
  addSurveyUrl: (entryId: number, url: SurveyEntry['urls'][0]) => void;
  removeSurveyUrl: (entryId: number, urlIdx: number) => void;
  updateSurveySize: (entryId: number, size: string) => void;
  updateSurveyUrlTitle: (entryId: number, formId: string, title: string, variant: string) => void;

  // DSPs
  toggleDsp: (dsp: DspType) => void;

  // Config
  setConfig: (updates: Partial<Pick<WizardState,
    'brand' | 'isPolitical' | 'xandrLangId' | 'xandrBrandId' | 'xandrBrandUrl' |
    'xandrSla' | 'dv360AdvId' | 'amazonAdvId' | 'amazonMarketplace'
  >>) => void;

  // Activation
  setActivating: (v: boolean) => void;
  setActivationDone: (v: boolean) => void;
  setActivationResults: (results: ActivationResult[]) => void;
  setGeneratedFiles: (files: Record<string, unknown>) => void;
  invalidateResults: () => void;
  /** Clear _storagePath/_uploadedFile for fresh upload (called before each activation) */
  resetAssetUploadState: () => void;
  /** Normalize all asset landing pages via normalizeUrl */
  normalizeAssetLandingPages: () => void;

  // ── Computed helpers (callable, not reactive) ──
  hasContent: () => boolean;
  hasDsp: () => boolean;
  getStepConfig: () => typeof WIZARD_CONFIGS[WizardMode];
}

const INITIAL_STATE = {
  mode: 'tags' as WizardMode,
  currentStep: 0,
  parsedData: null,
  selectedTagIds: new Set<number>(),
  tagsFilterType: 'all' as const,
  tagsFilterSize: 'all',
  tagsFilterText: '',
  assetEntries: [] as AssetEntry[],
  assetIdCounter: 0,
  selectedAssetIds: new Set<number>(),
  assetsFilterType: 'all' as const,
  assetsFilterSize: 'all',
  assetsFilterText: '',
  surveyEntries: [] as SurveyEntry[],
  surveyIdCounter: 0,
  selectedDsps: new Set<DspType>(),
  brand: '',
  isPolitical: false,
  xandrLangId: 8,
  xandrBrandId: '',
  xandrBrandUrl: '',
  xandrSla: 0,
  dv360AdvId: DSP_DEFAULTS.dv360.advertiserId,
  amazonAdvId: DSP_DEFAULTS.amazondsp.advertiserId,
  amazonMarketplace: DSP_DEFAULTS.amazondsp.defaultMarketplace,
  generatedFiles: {} as Record<string, unknown>,
  activationDone: false,
  activating: false,
  activationResults: [] as ActivationResult[],
};

export const useWizardStore = create<WizardState>((set, get) => ({
  ...INITIAL_STATE,

  enterWizard: (mode) => {
    set({
      ...INITIAL_STATE,
      // Deep-copy sets to avoid sharing references
      selectedTagIds: new Set(),
      selectedAssetIds: new Set(),
      selectedDsps: new Set(),
      generatedFiles: {},
      activationResults: [],
      mode,
      // Legacy: surveys mode pre-fills xandrBrandUrl with hypr.mobi
      xandrBrandUrl: mode === 'surveys' ? 'https://hypr.mobi' : '',
    });
  },

  resetWizard: () => {
    set({
      ...INITIAL_STATE,
      selectedTagIds: new Set(),
      selectedAssetIds: new Set(),
      selectedDsps: new Set(),
      generatedFiles: {},
      activationResults: [],
    });
  },

  setStep: (step) => {
    const s = get();
    const config = WIZARD_CONFIGS[s.mode];
    if (step < 0 || step >= config.steps.length) return;
    if (s.activating) return;

    // Validate prerequisites when advancing
    if (step > s.currentStep) {
      const targetStep = config.steps[step];
      const content = !!(s.parsedData?.placements?.length || s.surveyEntries.length || s.assetEntries.length);
      const dsp = s.selectedDsps.size > 0;
      if ((targetStep === 'dsps' || targetStep === 'config' || targetStep === 'activate') && !content) return;
      if ((targetStep === 'config' || targetStep === 'activate') && !dsp) return;
    }

    set({ currentStep: step });
  },

  // ── Tags ──

  setParsedData: (data) => set({ parsedData: data }),

  mergeParsedData: (newData) => {
    const { parsedData } = get();
    if (!parsedData || !parsedData.placements.length) {
      set({ parsedData: newData });
      return { added: newData.placements.length, skipped: 0 };
    }

    const existingIds = new Set(parsedData.placements.map((p) => String(p.placementId)));
    const newOnly = newData.placements.filter((p) => !existingIds.has(String(p.placementId)));
    const merged = { ...newData, placements: [...parsedData.placements, ...newOnly] };
    set({ parsedData: merged });
    return { added: newOnly.length, skipped: newData.placements.length - newOnly.length };
  },

  removeTagPlacements: (indices) => {
    const { parsedData, selectedTagIds } = get();
    if (!parsedData) return;
    const sorted = [...indices].sort((a, b) => b - a);
    const placements = [...parsedData.placements];
    sorted.forEach((idx) => placements.splice(idx, 1));
    const newSelection = new Set<number>();
    selectedTagIds.forEach((id) => { if (!indices.includes(id)) newSelection.add(id); });
    set({ parsedData: { ...parsedData, placements }, selectedTagIds: newSelection });
  },

  setTagsFilter: (filter) => {
    const s = get();
    set({
      tagsFilterType: filter.type ?? s.tagsFilterType,
      tagsFilterSize: filter.size ?? s.tagsFilterSize,
      tagsFilterText: filter.text ?? s.tagsFilterText,
    });
  },

  toggleTagSelection: (idx) => {
    const next = new Set(get().selectedTagIds);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    set({ selectedTagIds: next });
  },

  selectAllTags: (filtered) => set({ selectedTagIds: new Set(filtered) }),
  clearTagSelection: () => set({ selectedTagIds: new Set() }),

  updatePlacement: (idx, field, value) => {
    const { parsedData } = get();
    if (!parsedData) return;
    const placements = [...parsedData.placements];
    placements[idx] = { ...placements[idx], [field]: value };
    set({ parsedData: { ...parsedData, placements } });
  },

  addPlacementTracker: (idx, tracker) => {
    const { parsedData } = get();
    if (!parsedData) return;
    const placements = [...parsedData.placements];
    const p = { ...placements[idx] };
    if (!p.trackers.some((t) => t.url === tracker.url)) {
      p.trackers = [...p.trackers, tracker];
    }
    placements[idx] = p;
    set({ parsedData: { ...parsedData, placements } });
  },

  removePlacementTracker: (idx, trackerIdx) => {
    const { parsedData } = get();
    if (!parsedData) return;
    const placements = [...parsedData.placements];
    const p = { ...placements[idx] };
    p.trackers = p.trackers.filter((_, i) => i !== trackerIdx);
    placements[idx] = p;
    set({ parsedData: { ...parsedData, placements } });
  },

  // ── Assets ──

  addAssetEntries: (entries) => {
    set((s) => ({
      assetEntries: [...s.assetEntries, ...entries],
      assetIdCounter: entries.reduce((max, e) => Math.max(max, e.id), s.assetIdCounter),
    }));
  },

  removeAsset: (id) => {
    set((s) => {
      const nextSelection = new Set(s.selectedAssetIds);
      nextSelection.delete(id);
      return {
        assetEntries: s.assetEntries.filter((a) => a.id !== id),
        selectedAssetIds: nextSelection,
      };
    });
  },

  updateAsset: (id, updates) => {
    set((s) => ({
      assetEntries: s.assetEntries.map((a) => a.id === id ? { ...a, ...updates } : a),
    }));
  },

  duplicateAsset: (id) => {
    const { assetEntries, assetIdCounter } = get();
    const orig = assetEntries.find((a) => a.id === id);
    if (!orig) return;
    const newId = assetIdCounter + 1;
    const copy: AssetEntry = {
      ...orig,
      id: newId,
      name: orig.name + '_copy',
      landingPage: '',
      trackers: orig.trackers.map((t) => ({ ...t, dsps: t.dsps === 'all' ? 'all' : [...t.dsps] })),
    };
    set({ assetEntries: [...assetEntries, copy], assetIdCounter: newId });
  },

  toggleAssetSelection: (id) => {
    const next = new Set(get().selectedAssetIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ selectedAssetIds: next });
  },

  selectAllAssets: (filtered) => set({ selectedAssetIds: new Set(filtered) }),
  clearAssetSelection: () => set({ selectedAssetIds: new Set() }),

  setAssetsFilter: (filter) => {
    const s = get();
    set({
      assetsFilterType: filter.type ?? s.assetsFilterType,
      assetsFilterSize: filter.size ?? s.assetsFilterSize,
      assetsFilterText: filter.text ?? s.assetsFilterText,
    });
  },

  addAssetTracker: (id, tracker) => {
    set((s) => ({
      assetEntries: s.assetEntries.map((a) => {
        if (a.id !== id) return a;
        if (a.trackers.some((t) => t.url === tracker.url)) return a;
        return { ...a, trackers: [...a.trackers, tracker] };
      }),
    }));
  },

  removeAssetTracker: (id, trackerIdx) => {
    set((s) => ({
      assetEntries: s.assetEntries.map((a) => {
        if (a.id !== id) return a;
        return { ...a, trackers: a.trackers.filter((_, i) => i !== trackerIdx) };
      }),
    }));
  },

  getNextAssetId: () => {
    const next = get().assetIdCounter + 1;
    set({ assetIdCounter: next });
    return next;
  },

  // ── Surveys ──

  addSurveyEntry: (type) => {
    const nextId = get().surveyIdCounter + 1;
    set((s) => ({
      surveyEntries: [...s.surveyEntries, { id: nextId, type, size: '300x600', urls: [] }],
      surveyIdCounter: nextId,
    }));
  },

  removeSurveyEntry: (id) => {
    set((s) => ({ surveyEntries: s.surveyEntries.filter((e) => e.id !== id) }));
  },

  addSurveyUrl: (entryId, url) => {
    set((s) => ({
      surveyEntries: s.surveyEntries.map((e) =>
        e.id === entryId ? { ...e, urls: [...e.urls, url] } : e
      ),
    }));
  },

  removeSurveyUrl: (entryId, urlIdx) => {
    set((s) => ({
      surveyEntries: s.surveyEntries.map((e) =>
        e.id === entryId ? { ...e, urls: e.urls.filter((_, i) => i !== urlIdx) } : e
      ),
    }));
  },

  updateSurveySize: (entryId, size) => {
    set((s) => ({
      surveyEntries: s.surveyEntries.map((e) =>
        e.id === entryId ? { ...e, size } : e
      ),
    }));
  },

  updateSurveyUrlTitle: (entryId, formId, title, variant) => {
    set((s) => ({
      surveyEntries: s.surveyEntries.map((e) =>
        e.id === entryId
          ? { ...e, urls: e.urls.map((u) => u.formId === formId ? { ...u, title, variant } : u) }
          : e
      ),
    }));
  },

  // ── DSPs ──

  toggleDsp: (dsp) => {
    const next = new Set(get().selectedDsps);
    if (next.has(dsp)) next.delete(dsp); else next.add(dsp);
    set({ selectedDsps: next, generatedFiles: {}, activationDone: false });
  },

  // ── Config ──

  setConfig: (updates) => set(updates),

  // ── Activation ──

  setActivating: (v) => set({ activating: v }),
  setActivationDone: (v) => set({ activationDone: v }),
  setActivationResults: (results) => set({ activationResults: results }),
  setGeneratedFiles: (files) => set({ generatedFiles: files }),

  invalidateResults: () => set({
    generatedFiles: {},
    activationDone: false,
    activationResults: [],
  }),

  resetAssetUploadState: () => {
    set((s) => ({
      assetEntries: s.assetEntries.map((a) => ({
        ...a,
        _storagePath: undefined,
        _uploadedFile: undefined,
      })),
    }));
  },

  normalizeAssetLandingPages: () => {
    set((s) => ({
      assetEntries: s.assetEntries.map((a) => ({
        ...a,
        landingPage: a.landingPage ? normalizeUrl(a.landingPage) : a.landingPage,
      })),
    }));
  },

  // ── Computed helpers ──

  hasContent: () => {
    const s = get();
    return !!(
      s.parsedData?.placements?.length ||
      s.surveyEntries.length ||
      s.assetEntries.length
    );
  },

  hasDsp: () => get().selectedDsps.size > 0,

  getStepConfig: () => WIZARD_CONFIGS[get().mode],
}));
