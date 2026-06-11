/**
 * Remove CM360 carriage return artifacts from tag strings.
 * Ported from legacy: function cleanCR(s)
 */
export function cleanCR(s: string): string {
  return s.replace(/_x000d_/gi, '').replace(/\r/g, '');
}

/**
 * Normalize a URL by prepending https:// if it looks like a domain but lacks a scheme.
 * Ported from legacy: function normalizeUrl(v)
 */
export function normalizeUrl(v: string): string {
  let url = v.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url) && /^[a-zA-Z0-9]/.test(url) && url.includes('.')) {
    url = 'https://' + url;
  }
  return url;
}

/**
 * Validate that a string is a plausible URL.
 *
 * Strategy:
 *  1) Normalize (so "site.com" → "https://site.com").
 *  2) Parse with the URL constructor — guarantees scheme + valid structure.
 *  3) Require http/https scheme.
 *  4) Require a hostname with at least one dot and a TLD-like segment
 *     (>= 2 alpha chars) — blocks values like "abc", "localhost", "test text".
 *
 * Used to gate creative activation: DSPs (DV360 in particular) reject creatives
 * with invalid exit-event URLs (CREATIVE_EXIT_EVENT_CLICK_TAG_INVALID_URL), and
 * the rejection happens server-side after the create call. Catching it client-side
 * avoids partial activations like the one observed on May 21 2026.
 */
export function isValidUrl(v: string): boolean {
  const s = (v || '').trim();
  if (!s) return false;
  const normalized = normalizeUrl(s);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (!host || !host.includes('.')) return false;
  // Require a TLD segment with at least 2 alpha chars (rejects "site.1", "x.a")
  if (!/\.[a-zA-Z]{2,}$/.test(host)) return false;
  return true;
}

/**
 * Format bytes into human-readable string (B, KB, MB).
 * Ported from legacy: function formatBytes(b)
 */
export function formatBytes(b: number): string {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(0) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}

/**
 * Extract brand name from advertiser/campaign strings.
 * Ported from legacy: function extractBrand(a, c) — lines 1800
 */
export function extractBrand(advertiser: string, campaign: string): string {
  let b = advertiser;
  const m = b.match(/^PUB_[A-Z]+_[A-Z]{2,4}_(.+)$/i);
  if (m) b = m[1];
  if (!b || b.length < 2) {
    const p = campaign.match(/\|\s*(.+)/);
    if (p) b = p[1].trim();
  }
  return b || advertiser;
}

/**
 * Apply rename pattern to a name.
 * Supports prefix/suffix or full pattern with {name}, {size}, {type}, {index} placeholders.
 */
export function getRenamedName(
  original: string,
  prefix: string,
  suffix: string,
  pattern: string,
  index: number,
  meta: { dimensions?: string; type?: string },
): string {
  if (pattern) {
    return pattern
      .split('{name}').join(original)
      .split('{size}').join(meta.dimensions || '')
      .split('{type}').join(meta.type || '')
      .split('{index}').join(String(index + 1));
  }
  return (prefix || '') + original + (suffix || '');
}

/**
 * Extract a usable click/landing URL from a pasted ad tag.
 *
 * Priority:
 *  1) data-cta-url — explicit CTA attribute (AdCanvas, Nexd).
 *  2) href / url / landing attributes with a literal https URL.
 *  3) HYPR AdTag (`data-hypr-adtag`): the tag carries no literal landing —
 *     `data-clicktag` holds a DSP macro (${CLICK_URL}) expanded at serve time,
 *     and the real CTA lives inside the hosted creative. Fall back to
 *     `data-iframe-src` (platform.hypr.mobi/share/creatives/...), which is the
 *     raw-navigation destination per hypr-adtag.js and a valid https URL that
 *     satisfies the DSP exit-event requirement (DV360 would otherwise default
 *     to https://www.example.com inside dsp-dv360).
 *
 * Macro placeholders (${...}) are never returned as click URLs.
 */
export function extractTagClickUrl(tag: string): string {
  if (!tag) return '';
  const cta = tag.match(/data-cta-url\s*=\s*"(https?:\/\/[^"]+)"/i);
  if (cta) return cta[1];
  const href = tag.match(/(?:href|url|landing)\s*=\s*"(https?:\/\/[^"]+)"/i);
  if (href) return href[1];
  if (/data-hypr-adtag/i.test(tag)) {
    const src = tag.match(/data-iframe-src\s*=\s*"(https?:\/\/[^"]+)"/i);
    if (src) return src[1];
  }
  return '';
}
