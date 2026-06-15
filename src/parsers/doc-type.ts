/* ══════════════════════════════════════════════════════════════
   Document-type detector — runs BEFORE any tag/asset parser.

   Real HYPR taxonomy spreadsheets are not uniform. Sampling four
   production files surfaced three distinct document shapes:

     • tag-sheet   — carries servable tags / measurement pixels
                     (e.g. DoubleVerify dvtp_src.js, <script>, <img>,
                     VAST). These are the only ones an activation can
                     consume.
     • naming-only — a naming/taxonomy reference: ad names + a
                     destination (landing) URL and NOTHING servable.
                     Common HYPR headers: "Nome do anúncio e URL´s",
                     "Url Parametrizada".
     • unknown     — neither signature is present.

   The detector exists to FAIL LOUD. When a sheet has no servable
   tags we reject it with an explicit message instead of letting a
   downstream parser return an empty/garbage result silently. We
   never guess intent — guessing is what turns a parsing miss into a
   billing incident.
   ══════════════════════════════════════════════════════════════ */

export type DocType = 'tag-sheet' | 'naming-only' | 'unknown';

export interface DocTypeResult {
  type: DocType;
  /** Short machine-ish reason (for logs/audit). */
  reason: string;
  /** User-facing message — only set when the sheet is rejectable. */
  message?: string;
  /** What the scan found, for informative messaging. */
  counts: { servable: number; urls: number };
}

// A cell that looks like something you can actually traffic or that
// fires a beacon: an HTML tag, a known verification vendor, or a VAST doc.
const SERVABLE_SIGNS = [
  '<script', '<img', '<iframe', '<ins ', '<ins>',
  'doubleverify', 'dvtp_', 'dvbm.js',
  'adsafeprotected', 'iasds01', 'moatads',
  '<vast', 'vasttag', 'vpaid',
];

const URL_RE = /https?:\/\//i;

function cellHasServable(cell: string): boolean {
  const c = cell.toLowerCase();
  return SERVABLE_SIGNS.some((s) => c.includes(s));
}

/**
 * Classify a sheet (2D array of rows) by content signature.
 * Scans up to `maxRows` rows; that is plenty to recognize a shape
 * and keeps very large sheets cheap.
 */
export function detectDocType(rows: string[][], maxRows = 300): DocTypeResult {
  if (!rows || rows.length === 0) {
    return { type: 'unknown', reason: 'empty', message: 'Planilha vazia.', counts: { servable: 0, urls: 0 } };
  }

  let servableCells = 0;
  let urlCells = 0;
  const limit = Math.min(rows.length, maxRows);

  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    for (const raw of row) {
      const cell = String(raw ?? '').trim();
      if (!cell) continue;
      if (cellHasServable(cell)) {
        servableCells++;
      } else if (URL_RE.test(cell)) {
        urlCells++;
      }
    }
  }

  const counts = { servable: servableCells, urls: urlCells };

  if (servableCells > 0) {
    return { type: 'tag-sheet', reason: `${servableCells} servable cell(s)`, counts };
  }

  if (urlCells > 0) {
    return {
      type: 'naming-only',
      reason: `${urlCells} url cell(s), no servable tags`,
      counts,
      message:
        `Planilha de taxonomia/landing: ${urlCells} URL(s) de destino e nenhuma tag servível. ` +
        'Pra subir peças, use Standard Assets — eu preencho as landings nos criativos. ' +
        'Pra subir tags, use a planilha de tags/embeds do cliente.',
    };
  }

  return {
    type: 'unknown',
    reason: 'no servable tags and no urls',
    counts,
    message:
      'Não encontrei tags servíveis nem URLs nessa planilha. ' +
      'Confirme se é a planilha de tags/embeds correta.',
  };
}
