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
 * sheet. `fillAmazonDSPTemplate` (below) is what turns these rows into
 * a downloadable XLSX; this function only produces the data so unit
 * tests can assert row shape without loading any XLSX blob.
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

/**
 * Build a single <row> XML for Amazon's THIRD-PARTY DISPLAY sheet using
 * inline strings (`t="inlineStr"`). Inline strings keep this function
 * independent of the shared strings pool (sharedStrings.xml) inside the
 * blank — we don't have to append entries there and hope indices align.
 * Every Excel-compatible parser (including Amazon's) accepts inline
 * strings interchangeably with shared strings.
 */
function buildRowXml(rowNum: number, cells: string[]): string {
  const parts: string[] = [`<row r="${rowNum}">`];
  cells.forEach((val, idx) => {
    if (!val) return; // skip empty cells entirely — valid OOXML
    const ref = `${COLS[idx]}${rowNum}`;
    parts.push(
      `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`,
    );
  });
  parts.push('</row>');
  return parts.join('');
}

/**
 * Fill Amazon DSP's official blank XLSX template with placement data and
 * return it as a downloadable Blob.
 *
 * CRITICAL: this function operates on the XLSX as a ZIP, via JSZip, and
 * edits only `xl/worksheets/sheet4.xml` (the THIRD-PARTY DISPLAY sheet)
 * as a string replacement. Every other file inside the blank — the
 * pivot tables, drawings, external links, printer settings, shared
 * strings, calcChain, tables, comments, images, all 15 other sheets —
 * is written back byte-for-byte. This is the only way to preserve the
 * template structure Amazon's bulk upload parser validates against.
 *
 * A prior implementation used SheetJS's `read() + write()` round-trip
 * and silently produced a corrupted XLSX (Excel offered to "repair"
 * the file and Amazon rejected it), because SheetJS community drops
 * support for many of the template's internal parts when re-emitting.
 * Do not reintroduce SheetJS here.
 */
export async function fillAmazonDSPTemplate(
  placements: Placement[],
  advertiserId: string,
  marketplace: string,
): Promise<Blob> {
  const JSZip = window.JSZip;
  if (!JSZip) {
    throw new Error('JSZip não carregou do CDN. Recarregue a página e tente novamente.');
  }

  const { rows } = genAmazonDSP(placements, advertiserId, marketplace);
  if (!rows.length) {
    throw new Error('Nenhum placement display para exportar — Amazon DSP não aceita vídeo neste fluxo.');
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

  // Build all new rows at once
  const newRowsXml = rows.map((cells, i) => buildRowXml(4 + i, cells)).join('');
  const lastRow = 3 + rows.length;

  // Surgically replace <sheetData>...</sheetData> — preserve rows 1-3
  // (scaffolding: Required markers / headers / tooltips) exactly as-is
  // from the blank, then append the new data rows starting at row 4.
  const sheetDataRe = /<sheetData>([\s\S]*?)<\/sheetData>/;
  const match = sheetDataRe.exec(sheet4);
  if (!match) {
    throw new Error('Template blank sem <sheetData> na sheet THIRD-PARTY DISPLAY.');
  }
  const existingRows = match[1];
  const preservedRows: string[] = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g;
  for (let m = rowRe.exec(existingRows); m !== null; m = rowRe.exec(existingRows)) {
    if (parseInt(m[1], 10) <= 3) preservedRows.push(m[0]);
  }
  sheet4 = sheet4.replace(
    sheetDataRe,
    `<sheetData>${preservedRows.join('')}${newRowsXml}</sheetData>`,
  );

  // Keep <dimension> in sync so Excel/parsers know the used range.
  sheet4 = sheet4.replace(
    /<dimension ref="[^"]*"\/>/,
    `<dimension ref="A1:M${lastRow}"/>`,
  );

  zip.file('xl/worksheets/sheet4.xml', sheet4);

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
