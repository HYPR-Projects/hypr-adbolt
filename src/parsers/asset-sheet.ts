/* ══════════════════════════════════════════════════════════════
   Asset spreadsheet parser — Standard Assets bulk metadata import

   Reads a flat sheet (one row per creative) and extracts, per row:
     - creative code  (unique key, derived from the name's last segment)
     - size           (normalized WxH)
     - name           (full creative/ad name)
     - landing        (click-tracker URL → goes into landingPage)
     - trackers       (impression + verification → fire on impression)

   Intelligence is content-first: the role of every tracker cell is
   decided by the URL signature, NOT by which column it sits in. A
   trackclk is always a click/landing even under a header named
   "impression"; a trackimp/DoubleVerify is always impression even if
   dumped in a "click" column. Header text is only a tiebreaker for
   distinguishing the size column from the name column.
   ══════════════════════════════════════════════════════════════ */

import type { TrackerFormat } from '@/types';
import { analyzeTracker } from './tracker';

export type TrackerRole = 'impression' | 'click' | 'verification' | 'unknown';

export interface SheetTracker {
  url: string;
  format: TrackerFormat;
  role: TrackerRole;
}

export interface AssetSheetRow {
  /** Normalized creative code (e.g. "36.5"); null when none can be derived. */
  code: string | null;
  /** Normalized size, e.g. "300x250"; '' when absent. */
  size: string;
  /** Full creative/ad name. */
  name: string;
  /** Click-tracker URL (trackclk) → mapped to landingPage. */
  landing: string;
  /** Impression + verification trackers (both fire on impression). */
  trackers: SheetTracker[];
  /** Placement ID parsed from a tracker URL, when present. */
  placementId: string | null;
}

export interface AssetSheetParse {
  rows: AssetSheetRow[];
  headerRowIndex: number;
  sizeCol: number;
  nameCol: number;
  warnings: string[];
}

// Verification / brand-safety vendors. These beacons fire on impression.
const VERIFICATION_SIGNS = [
  'doubleverify.com', 'dvbm.js', 'dvtp_', 'cdn.doubleverify',
  'adsafeprotected.com', 'iasds01.com', 'pixel.adsafeprotected', // IAS
  'moatads.com', 'moat.com', // Moat
];

const SIZE_RE = /^\s*\d{2,4}\s*[x×]\s*\d{2,4}\s*$/i;
const CODE_TOKEN_RE = /^\d+(?:[._,]\d+)*$/;

export function normalizeSize(s: string): string {
  return (s || '').toLowerCase().replace(/\s/g, '').replace(/×/g, 'x');
}

export function normalizeCode(c: string): string {
  return (c || '').trim().toLowerCase().replace(/[_,]/g, '.').replace(/\s/g, '');
}

/**
 * Derive the creative code from a name/filename.
 *  - "OBoticario|...|300x250|36_5"  → "36.5"  (last pipe segment)
 *  - "cód 36.5 - 300x250"           → "36.5"  (códNN pattern)
 *  - "36.5 - banner"                → "36.5"  (leading code + separator)
 * Returns null when nothing code-like is found (caller falls back to size).
 */
export function extractCode(raw: string): string | null {
  const v = (raw || '').trim();
  if (!v) return null;

  // 1) Pipe taxonomy → last segment
  if (v.includes('|')) {
    const last = v.split('|').pop()!.trim();
    if (CODE_TOKEN_RE.test(last)) return normalizeCode(last);
  }

  // 2) "cód NN" / "cod NN" / "code NN"
  const codMatch = v.match(/c[oó]d(?:e|igo)?[\s._:#-]*?(\d+(?:[._,]\d+)*)/i);
  if (codMatch) return normalizeCode(codMatch[1]);

  // 3) Leading code followed by a real separator (not the 'x' of a size)
  const leadMatch = v.match(/^(\d+(?:[._,]\d+)*)\s*[-–—|]/);
  if (leadMatch) return normalizeCode(leadMatch[1]);

  return null;
}

/**
 * Classify a single tracker cell by URL signature. Order matters:
 * verification first (a DV tag may contain "imp"/"clk" substrings),
 * then click, then impression.
 */
export function classifyTrackerCell(raw: string): SheetTracker | null {
  const t = (raw || '').trim();
  if (!t) return null;
  // Must contain an http(s) URL or an HTML tag — otherwise it's not a tracker.
  if (!/https?:\/\//i.test(t) && !/^</.test(t)) return null;

  const { url, format } = analyzeTracker(t);
  const hay = (url + ' ' + t).toLowerCase();

  let role: TrackerRole;
  if (VERIFICATION_SIGNS.some((s) => hay.includes(s))) {
    role = 'verification';
  } else if (/trackclk|\/ddm\/[^\s"']*clk|[?&/](clk|click)(=|\/|\b)|\/click(\/|\b)/.test(hay)) {
    role = 'click';
  } else if (/trackimp|\/ddm\/[^\s"']*imp|impression|[?&/](imp|impr)(=|\/|\b)|\.gif(\?|$)/.test(hay)) {
    role = 'impression';
  } else {
    role = 'unknown';
  }

  return { url, format, role };
}

function parsePlacementId(url: string): string | null {
  // DCM pattern: .../B<campaign>.<placement>;dc_trk_aid=...
  const m = url.match(/\bB\d+\.(\d+)/);
  if (m) return m[1];
  // DoubleVerify: plc=<id>
  const dv = url.match(/[?&#]plc=(\d+)/);
  if (dv) return dv[1];
  return null;
}

const SIZE_HEADER_RE = /tamanho|size|dimens|formato/i;
const NAME_HEADER_RE = /an[uú]ncio|nome|name|criativ|linha/i;

/** Find the header row within the first 10 rows (HYPR re-exports can offset it). */
function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].map((c) => String(c || '').toLowerCase());
    const hasSize = cells.some((c) => SIZE_HEADER_RE.test(c));
    const hasTrackerOrName =
      cells.some((c) => NAME_HEADER_RE.test(c)) ||
      cells.some((c) => /track|verify|impre|click|pixel/i.test(c));
    if (hasSize && hasTrackerOrName) return i;
  }
  // Fallback: a row whose cells include something size-like in the row below
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const next = rows[i + 1] || [];
    if (next.some((c) => SIZE_RE.test(String(c || '')))) return i;
  }
  return 0;
}

/**
 * Pick the size column and the name column using content votes, with the
 * header text as a tiebreaker. Every other column is swept cell-by-cell as
 * a potential tracker source.
 */
function resolveStructuralCols(
  header: string[],
  dataRows: string[][],
): { sizeCol: number; nameCol: number } {
  const nCols = header.length;
  const sample = dataRows.slice(0, 25);

  let sizeCol = -1;
  let nameCol = -1;
  let bestSizeScore = 0;
  let bestNameScore = 0;

  for (let c = 0; c < nCols; c++) {
    const head = String(header[c] || '').toLowerCase();
    const cells = sample.map((r) => String(r[c] ?? '').trim()).filter(Boolean);
    if (!cells.length) continue;

    const sizeHits = cells.filter((v) => SIZE_RE.test(v)).length / cells.length;
    const pipeHits = cells.filter((v) => (v.match(/\|/g) || []).length >= 3).length / cells.length;
    const urlHits = cells.filter((v) => /https?:\/\//i.test(v) || /^</.test(v)).length / cells.length;

    // Size: content vote + header boost
    const sizeScore = sizeHits + (SIZE_HEADER_RE.test(head) ? 0.5 : 0);
    if (sizeHits > 0.5 && sizeScore > bestSizeScore) {
      bestSizeScore = sizeScore;
      sizeCol = c;
    }

    // Name: prefer pipe taxonomy; never a tracker column
    const nameScore = pipeHits * 2 + (NAME_HEADER_RE.test(head) ? 0.5 : 0);
    if (urlHits < 0.3 && sizeHits < 0.3 && nameScore > bestNameScore) {
      bestNameScore = nameScore;
      nameCol = c;
    }
  }

  return { sizeCol, nameCol };
}

export function parseAssetSheet(rows: string[][]): AssetSheetParse {
  const warnings: string[] = [];
  if (!rows || rows.length < 2) {
    return { rows: [], headerRowIndex: -1, sizeCol: -1, nameCol: -1, warnings: ['Planilha vazia ou sem linhas de dados.'] };
  }

  const headerRowIndex = findHeaderRow(rows);
  const header = rows[headerRowIndex].map((c) => String(c || ''));
  const dataRows = rows.slice(headerRowIndex + 1).filter((r) => r.some((c) => String(c || '').trim()));

  const { sizeCol, nameCol } = resolveStructuralCols(header, dataRows);
  if (nameCol === -1) warnings.push('Não identifiquei a coluna de nome do criativo.');
  if (sizeCol === -1) warnings.push('Não identifiquei a coluna de tamanho — vou depender do código/nome do arquivo.');

  const structural = new Set([sizeCol, nameCol].filter((c) => c >= 0));

  const parsed: AssetSheetRow[] = [];
  for (const row of dataRows) {
    const name = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : '';
    const size = sizeCol >= 0 ? normalizeSize(String(row[sizeCol] ?? '')) : '';

    let landing = '';
    let placementId: string | null = null;
    const trackers: SheetTracker[] = [];

    for (let c = 0; c < row.length; c++) {
      if (structural.has(c)) continue;
      const cell = String(row[c] ?? '').trim();
      if (!cell) continue;
      // A cell may hold multiple URLs (newline / semicolon separated)
      const parts = cell.split(/[\r\n]+|;\s*(?=https?:\/\/|<)/).map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        const tr = classifyTrackerCell(part);
        if (!tr) continue;
        if (!placementId) placementId = parsePlacementId(tr.url);
        if (tr.role === 'click') {
          if (!landing) landing = tr.url; // first click tracker becomes the landing
        } else if (tr.role === 'impression' || tr.role === 'verification') {
          if (!trackers.some((x) => x.url === tr.url)) trackers.push(tr);
        }
        // 'unknown' tracker-shaped cells are ignored on purpose (no silent misrouting)
      }
    }

    // Code: prefer the structured name, fall back to size token only as last resort
    const code = extractCode(name);

    // Skip fully empty rows
    if (!name && !size && !landing && !trackers.length) continue;

    parsed.push({ code, size, name, landing, trackers, placementId });
  }

  if (!parsed.length) warnings.push('Nenhuma linha de criativo encontrada.');

  return { rows: parsed, headerRowIndex, sizeCol, nameCol, warnings };
}
