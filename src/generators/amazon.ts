import type { Placement } from '@/types';
import { mergeTrackerUrls } from '@/parsers/tracker';
import { SUPABASE_FUNCTIONS_URL } from '@/services/supabase';

// ── Marketplace → Language ──────────────────────────────────────────
// Amazon DSP's bulk upload binds the Language dropdown to the selected
// Marketplace via an INDIRECT() formula on column E, so only a subset
// of languages is valid per marketplace. The defaults below match what
// the HYPR team ships for each region.
const MARKETPLACE_LANG: Record<string, string> = {
  BR: 'Portuguese', US: 'English', MX: 'Spanish', UK: 'English',
  DE: 'German', FR: 'French', ES: 'Spanish', IT: 'Italian',
  JP: 'Japanese', CA: 'English', AU: 'English', IN: 'English',
  NL: 'Dutch', SA: 'Arabic', SE: 'Swedish', TR: 'Turkish', AE: 'English',
};

// Dropdown values that Amazon DSP's bulk upload UI expects verbatim.
// These strings must match the blank template's <si> entries in
// xl/sharedStrings.xml so that adbolt-amazon-xlsx can reference them
// by index (<c t="s">). Any drift silently drops the row on import.
const CREATIVE_TEMPLATE_3P_DISPLAY = 'Third-party Display';
const DEST_ANOTHER_WEBSITE = 'Links to another website';
const DEST_AMAZON_WEBSITE = 'Links to an Amazon website';

// ── Amazon destination detection ────────────────────────────────────

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

// DCM/CM360 tags are black boxes: the click URL is resolved by the
// DCM SDK at render time and is NOT present in the tag HTML or in
// `click_url` (which points to an ad.doubleclick.net/ddm/jump/ redirect).
// When the tag and URLs carry no Amazon signal, the creative naming
// convention is often the only clue. Markers commonly used across HYPR
// workflows: AMZ, AMAZON, AMZN (explicit), ODSP (Amazon Onsite Display),
// ADSP (Amazon DSP). Match requires separator boundaries so "LAMAZING"
// or "ODSPR" do not trigger false positives.
const AMAZON_NAME_MARKER_RE =
  /(?:^|[_\-.\s])(amazon|amzn|amz|odsp|adsp)(?:[_\-.\s]|$)/i;

function hasAmazonNameMarker(name: string): boolean {
  if (!name) return false;
  return AMAZON_NAME_MARKER_RE.test(name);
}

function detectClickDestination(p: Placement): string {
  if (isAmazonUrl(p.clickUrl)) return DEST_AMAZON_WEBSITE;
  const fromTag = extractClickFromTag(p.jsTag);
  if (isAmazonUrl(fromTag)) return DEST_AMAZON_WEBSITE;
  if (hasAmazonNameMarker(p.placementName)) return DEST_AMAZON_WEBSITE;
  return DEST_ANOTHER_WEBSITE;
}

// ── Row builder ─────────────────────────────────────────────────────

/**
 * Build the per-placement rows for the Amazon DSP THIRD-PARTY DISPLAY
 * sheet (rows 4..N of sheet4.xml). Exported so the adbolt-amazon-xlsx
 * edge function and tests share the same row shape.
 *
 * Column order (A..M) matches the blank template's row 3 headers:
 *   A  Advertiser ID           H  Size
 *   B  Creative Template       I  Tag Source
 *   C  Name                    J  Click-through destination
 *   D  Marketplace             K  Third party-impression URL
 *   E  Language                L  AdChoices location
 *   F  Creative ID             M  Additional html
 *   G  External ID
 *
 * Video placements are excluded — this sheet only accepts third-party
 * display tags. Video creatives belong in a separate sheet (not supported
 * by AdBolt yet).
 */
export function genAmazonDSP(
  placements: Placement[],
  advertiserId: string,
  marketplace: string,
): string[][] {
  const lang = MARKETPLACE_LANG[marketplace] || 'Portuguese';

  return placements
    .filter((p) => p.type !== 'video')
    .map((p) => {
      const pxUrls = mergeTrackerUrls(p.trackers || [], 'amazondsp');
      const destination = detectClickDestination(p);
      return [
        advertiserId, CREATIVE_TEMPLATE_3P_DISPLAY, p.placementName, marketplace, lang,
        '', '', p.dimensions, p.jsTag, destination,
        pxUrls.join('\n'), '', '',
      ];
    });
}

// ── Server-side XLSX generation ─────────────────────────────────────

const AMAZON_XLSX_ENDPOINT = `${SUPABASE_FUNCTIONS_URL}/adbolt-amazon-xlsx`;

/**
 * Generate the Amazon DSP XLSX server-side and return the blob for download.
 *
 * Why server-side:
 * Amazon DSP's bulk import validates that cells reference sharedStrings
 * (<c t="s"><v>INDEX</v></c>) rather than inline strings. Every browser-
 * side XLSX library we tried (SheetJS, ExcelJS with full re-serialize,
 * JSZip surgical edits emitting inlineStr) produced files that Amazon
 * silently rejected with "0 creatives saved". The adbolt-amazon-xlsx
 * edge function preserves the official blank bytes and rewrites specific
 * rows in sheet4.xml plus the sharedStrings pool — this shape passes
 * every validation. See the edge function source for the technical note.
 */
export async function fillAmazonDSPTemplate(
  placements: Placement[],
  advertiserId: string,
  marketplace: string,
): Promise<Blob> {
  const rows = genAmazonDSP(placements, advertiserId, marketplace);
  if (!rows.length) {
    throw new Error('Nenhum placement display para exportar — Amazon DSP não aceita vídeo neste fluxo.');
  }
  if (rows.length > 91) {
    throw new Error(`Amazon DSP suporta no máximo 91 placements por template (recebi ${rows.length}).`);
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
