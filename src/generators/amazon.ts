import type { Placement } from '@/types';
import { mergeTrackerUrls } from '@/parsers/tracker';

export interface AmazonDSPGeneratedFile {
  headers: string[];
  rows: string[][];
  type: 'xlsx';
  sheetName: string;
  colWidths: Array<{ wch: number }>;
}

const MARKETPLACE_LANG: Record<string, string> = {
  BR: 'Portuguese', US: 'English', MX: 'Spanish', UK: 'English',
  DE: 'German', FR: 'French', ES: 'Spanish', IT: 'Italian',
  JP: 'Japanese', CA: 'English', AU: 'English', IN: 'English',
  NL: 'Dutch', SA: 'Arabic', SE: 'Swedish', TR: 'Turkish', AE: 'English',
};

const AMAZON_HEADERS = [
  'Advertiser ID*', 'Creative Template*', 'Name*', 'Marketplace*',
  'Language*', 'Creative ID', 'External ID', 'Size*', 'Tag Source*',
  'Click-through destination*', 'Third party-impression URL',
  'AdChoices location', 'Additional html',
];

/**
 * Build the per-placement rows for the Amazon DSP THIRD-PARTY DISPLAY
 * sheet. `fillAmazonDSPTemplate` turns these rows into a downloadable
 * XLSX by injecting them into the official blank template. Tests cover
 * this function directly (row shape, marketplace/language, video filter).
 */
export function genAmazonDSP(
  placements: Placement[],
  advertiserId: string,
  marketplace: string,
): AmazonDSPGeneratedFile {
  const lang = MARKETPLACE_LANG[marketplace] || 'Portuguese';

  return {
    headers: AMAZON_HEADERS,
    rows: placements
      .filter((p) => p.type !== 'video')
      .map((p) => {
        const pxUrls = mergeTrackerUrls(p.trackers || [], 'amazondsp');
        return [
          advertiserId, 'Third-party Display', p.placementName, marketplace, lang,
          '', '', p.dimensions, p.jsTag, 'Links to another website',
          pxUrls.join('\n'), '', '',
        ];
      }),
    type: 'xlsx',
    sheetName: 'THIRD-PARTY DISPLAY',
    colWidths: [
      { wch: 16 }, { wch: 18 }, { wch: 45 }, { wch: 15 }, { wch: 14 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 60 }, { wch: 28 },
      { wch: 40 }, { wch: 16 }, { wch: 30 },
    ],
  };
}

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildCellXml(col: string, rowNum: number, val: string): string {
  if (!val) return '';
  return `<c r="${col}${rowNum}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
}

/**
 * Fill Amazon DSP's official blank XLSX template with placement data and
 * return it as a downloadable Blob.
 *
 * Preserves the blank template's structure EXACTLY: the only change to the
 * output is that rows 4..4+N-1 of the THIRD-PARTY DISPLAY sheet get their
 * cells replaced with the user's placement data. Everything else â row 1-3
 * scaffolding, empty placeholder rows 4+N..94, closing row 95, dimension
 * A1:M95, mergeCells, dataValidations (INDIRECT dropdowns), all 15 other
 * sheets including hidden Template Info (V2), validation lists,
 * sharedStrings, calcChain, drawings, pivot tables, external links â is
 * byte-for-byte from the official blank.
 *
 * Amazon's bulk upload parser validates the template's hidden
 * Template Info metadata and cross-sheet validations. Any previous
 * approach that regenerated the XLSX (SheetJS) or destructively edited
 * the sheet (overwriting <sheetData>, shrinking <dimension>) failed
 * precisely because those guarantees were violated. This function only
 * swaps the INNER content of existing <row> tags while preserving the
 * opening tag's attributes (spans, x14ac:dyDescent).
 *
 * Do not reintroduce SheetJS in the write path here.
 */
export async function fillAmazonDSPTemplate(
  placements: Placement[],
  advertiserId: string,
  marketplace: string,
): Promise<Blob> {
  const JSZip = window.JSZip;
  if (!JSZip) {
    throw new Error('JSZip nÃ£o carregou do CDN. Recarregue a pÃ¡gina e tente novamente.');
  }

  const { rows } = genAmazonDSP(placements, advertiserId, marketplace);
  if (!rows.length) {
    throw new Error('Nenhum placement display para exportar â Amazon DSP nÃ£o aceita vÃ­deo neste fluxo.');
  }
  if (rows.length > 91) {
    // Amazon's blank provides 91 placeholder rows (4..94). If the campaign
    // has more, we'd need to grow the sheet â not implemented yet.
    throw new Error(`Amazon DSP suporta no mÃ¡ximo 91 placements por template (recebi ${rows.length}).`);
  }

  const resp = await fetch('/templates/amazondsp-blank.xlsx', { cache: 'force-cache' });
  if (!resp.ok) {
    throw new Error(`Falha ao carregar template blank da Amazon DSP (HTTP ${resp.status}).`);
  }

  const zip = await JSZip.loadAsync(await resp.arrayBuffer());
  const sheet4File = zip.file('xl/worksheets/sheet4.xml');
  if (!sheet4File) {
    throw new Error('Template blank da Amazon DSP corrompido: xl/worksheets/sheet4.xml ausente.');
  }
  let sheet4 = await sheet4File.async('string');

  // Surgical per-row replacement: keep the <row ...> opening tag intact
  // (preserves spans/dyDescent/style metadata Amazon expects), replace
  // only the row's INNER cell content.
  rows.forEach((cells, i) => {
    const rowNum = 4 + i;
    const cellsXml = cells
      .map((val, colIdx) => buildCellXml(COLS[colIdx], rowNum, val))
      .join('');
    const rowRe = new RegExp(`(<row r="${rowNum}"[^>]*>)[^]*?</row>`);
    sheet4 = sheet4.replace(rowRe, (_match, openTag: string) =>
      `${openTag}${cellsXml}</row>`,
    );
  });

  zip.file('xl/worksheets/sheet4.xml', sheet4);

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}
