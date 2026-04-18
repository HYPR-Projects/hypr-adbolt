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

// Amazon DSP dropdown values for the Creative Template and
// Click-through destination columns. The bulk upload UI rejects any
// cell value that doesn't match the dropdown exactly, so these strings
// must never drift from what the official blank template allows.
const CREATIVE_TEMPLATE_3P_DISPLAY = 'Third-party Display';
const DEST_ANOTHER_WEBSITE = 'Links to another website';
const DEST_AMAZON_WEBSITE = 'Links to an Amazon website';

// Hostname whitelist for "Amazon website" detection. Covers all amazon
// ccTLDs, Prime Video, Audible, and the Amazon short link a.co.
function isAmazonHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'a.co' || h.endsWith('.a.co')) return true;
  return /(^|\.)(amazon|primevideo|audible)\.[a-z.]+$/.test(h);
}

function isAmazonUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return isAmazonHost(u.hostname);
  } catch {
    return false;
  }
}

// Extract the most likely click destination from a 3P tag. DCM/CM360
// tags usually carry it on `data-cta-url` or an `<a href>`; other
// networks use `clickTag=` or similar. We try the common shapes and
// return the first match.
function extractClickFromTag(tag: string): string {
  if (!tag) return '';
  const patterns = [
    /data-cta-url\s*=\s*["']([^"']+)["']/i,
    /data-click-url\s*=\s*["']([^"']+)["']/i,
    /<a[^>]+href\s*=\s*["']([^"']+)["']/i,
    /clickTag\s*=\s*["']([^"']+)["']/i,
    /[?&]click[^=]*=([^&"'\s]+)/i,
  ];
  for (const re of patterns) {
    const m = tag.match(re);
    if (m && m[1]) {
      try {
        // Some trackers wrap the landing URL as a URL-encoded param
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
  }
  return '';
}

// Decide the "Click-through destination*" column value.
//
// IMPORTANT — why the default is DEST_ANOTHER_WEBSITE and why we do NOT
// infer DEST_AMAZON_WEBSITE from naming conventions like ODSP/AMZ/AMAZON:
//
// Amazon DSP validates that the declared destination is consistent with
// the literal content of the 3P tag source at upload time. It does NOT
// follow redirects. For tags that wrap the real landing in a DCM jump
// URL (<ins class='dcmads' data-dcm-placement='...'>) or any other
// opaque redirect, Amazon DSP sees no amazon.* hostname in the source
// and, if we declared "Links to an Amazon website", silently drops the
// creative during bulk import ("0 creatives saved", no error shown).
//
// Confirmed empirically on April 18 2026 with a Colgate batch of DCM
// tags whose real landing was amazon.com.br: declaring "Amazon website"
// based on the ODSP_ marker in the creative name produced zero saved
// creatives; declaring "another website" uploaded all of them. See
// also: https://advertising.amazon.com/resources/ad-policy/approved-3p-ad-servers
//
// So the rule is: only declare DEST_AMAZON_WEBSITE when an amazon.*
// hostname is *literally* present in the tag source or click URL —
// cases where Amazon DSP can see and validate it. Everything else,
// including DCM-wrapped Amazon campaigns, goes to DEST_ANOTHER_WEBSITE.
function detectClickDestination(p: Placement): string {
  if (isAmazonUrl(p.clickUrl)) return DEST_AMAZON_WEBSITE;
  const fromTag = extractClickFromTag(p.jsTag);
  if (isAmazonUrl(fromTag)) return DEST_AMAZON_WEBSITE;
  return DEST_ANOTHER_WEBSITE;
}

/**
 * Build the per-placement rows for the Amazon DSP THIRD-PARTY DISPLAY
 * sheet. Kept here so tests can exercise the row shape directly.
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
        const destination = detectClickDestination(p);
        return [
          advertiserId, CREATIVE_TEMPLATE_3P_DISPLAY, p.placementName, marketplace, lang,
          '', '', p.dimensions, p.jsTag, destination,
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

const AMAZON_XLSX_ENDPOINT = 'https://adfnabuwzmojxbhcpdpe.supabase.co/functions/v1/adbolt-amazon-xlsx';

/**
 * Generate the final Amazon DSP XLSX server-side and return the downloadable blob.
 *
 * Why server-side:
 * The exact same JSZip 3.10.1 fill-and-repack logic, when run in the
 * browser, produced files that Excel flagged on open ("We found a problem
 * with some content") and that Amazon DSP rejected with "Bulk upload has
 * failed". The same code running in a Deno edge function produced files
 * that pass both checks â confirmed with three server-generated variants
 * the user successfully uploaded to Amazon. Rather than keep hunting the
 * browser-side gremlin (cache, CDN ordering, SheetJS/JSZip interaction,
 * Blob writer quirks, etc.), generation is delegated to Supabase edge
 * runtime where we know it works.
 *
 * The frontend posts only the per-row array. The edge function fetches
 * the latest official blank from /templates/amazondsp-blank.xlsx, runs the
 * surgical sheet4.xml row replacement, repacks with compression:DEFLATE
 * level 9, and streams the XLSX back. No JSZip call happens in the
 * browser anymore for this flow.
 */
export async function fillAmazonDSPTemplate(
  placements: Placement[],
  advertiserId: string,
  marketplace: string,
): Promise<Blob> {
  const { rows } = genAmazonDSP(placements, advertiserId, marketplace);
  if (!rows.length) {
    throw new Error('Nenhum placement display para exportar â Amazon DSP nÃ£o aceita vÃ­deo neste fluxo.');
  }
  if (rows.length > 91) {
    throw new Error(`Amazon DSP suporta no mÃ¡ximo 91 placements por template (recebi ${rows.length}).`);
  }

  const resp = await fetch(AMAZON_XLSX_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json() as { error?: string };
      detail = j?.error || '';
    } catch {
      detail = await resp.text();
    }
    throw new Error(`Falha ao gerar XLSX Amazon DSP (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  return resp.blob();
}
