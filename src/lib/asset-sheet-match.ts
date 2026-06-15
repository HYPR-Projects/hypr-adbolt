/* ══════════════════════════════════════════════════════════════
   Asset ↔ sheet-row matcher

   Priority of signals (most → least reliable):
     1. Creative code   — unique key from the name's trailing segment.
                          Resolves same-size collisions on its own.
     2. Size validation — when a code matches, the size must agree;
                          mismatch is flagged, never silently applied.
     3. Size fallback    — when no code is available on one side, match
                          by dimension. Unique size auto-assigns; a
                          collision is surfaced for a 1-click decision.

   Nothing is ever guessed into place: a residual collision becomes an
   `ambiguous` entry with candidate rows and a suggested pick.
   ══════════════════════════════════════════════════════════════ */

import { extractCode, normalizeSize, type AssetSheetRow } from '@/parsers/asset-sheet';

export interface MatchAsset {
  id: number;
  name: string;
  dimensions: string;
  type: string;
  thumb?: string;
}

export interface Assignment {
  assetId: number;
  row: AssetSheetRow;
  confidence: 'high' | 'medium';
  reason: string;
  sizeMismatch: boolean;
}

export interface Ambiguity {
  assetId: number;
  asset: MatchAsset;
  candidates: AssetSheetRow[];
  suggestedIdx: number;
}

export interface MatchResult {
  matched: Assignment[];
  ambiguous: Ambiguity[];
  unmatchedAssets: MatchAsset[];
  unmatchedRows: AssetSheetRow[];
}

export function matchAssets(assets: MatchAsset[], rows: AssetSheetRow[]): MatchResult {
  const matched: Assignment[] = [];
  const ambiguous: Ambiguity[] = [];
  const unmatchedAssets: MatchAsset[] = [];
  const usedRows = new Set<AssetSheetRow>();
  const pendingAssets: MatchAsset[] = [];

  // Index rows by normalized code
  const byCode = new Map<string, AssetSheetRow[]>();
  for (const r of rows) {
    if (!r.code) continue;
    const arr = byCode.get(r.code) || [];
    arr.push(r);
    byCode.set(r.code, arr);
  }

  // ── Pass 1: creative code ──
  for (const a of assets) {
    const code = extractCode(a.name);
    if (!code) { pendingAssets.push(a); continue; }
    const candidates = (byCode.get(code) || []).filter((r) => !usedRows.has(r));
    if (candidates.length === 1) {
      const row = candidates[0];
      usedRows.add(row);
      const sizeMismatch = !!(row.size && a.dimensions && normalizeSize(a.dimensions) !== row.size);
      matched.push({ assetId: a.id, row, confidence: 'high', reason: `código ${code}`, sizeMismatch });
    } else if (candidates.length > 1) {
      ambiguous.push({ assetId: a.id, asset: a, candidates, suggestedIdx: 0 });
    } else {
      pendingAssets.push(a);
    }
  }

  // ── Pass 2: size fallback for assets without a code match ──
  for (const a of pendingAssets) {
    const size = normalizeSize(a.dimensions);
    const candidates = rows.filter((r) => !usedRows.has(r) && r.size && r.size === size);
    if (candidates.length === 1) {
      const row = candidates[0];
      usedRows.add(row);
      matched.push({ assetId: a.id, row, confidence: 'medium', reason: `dimensão ${size}`, sizeMismatch: false });
    } else if (candidates.length > 1) {
      ambiguous.push({ assetId: a.id, asset: a, candidates, suggestedIdx: 0 });
    } else {
      unmatchedAssets.push(a);
    }
  }

  const consumedInAmbiguity = new Set(ambiguous.flatMap((x) => x.candidates));
  const unmatchedRows = rows.filter((r) => !usedRows.has(r) && !consumedInAmbiguity.has(r));

  return { matched, ambiguous, unmatchedAssets, unmatchedRows };
}
