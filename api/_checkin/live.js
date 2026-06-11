// Live-layer resolvers that are pure string functions — kept out of
// api/snapshot.js so they can be unit-tested without importing the heavy
// puppeteer/chromium/single-file stack.

// HYPR AdTag → hosted-creative embed URL. Returns data-iframe-src ONLY when the
// tag is a HYPR AdTag (data-hypr-adtag host div); returns null for every other
// tag so they stay frozen — rendering a real 3P serving tag (CM360, Xandr,
// DV360) would fire billable impressions/clicks.
//
// The URL is returned BARE on purpose: hypr-adtag.js gates impressions/events
// behind a delivery URL param (dlv=..., appended by withDeliveryParams at serve
// time), so the bare hosted-creative URL fires NO billable beacons — same
// rationale as the Typeform direct-iframe path. Never append dlv/clicktag/cb
// here.
export function resolveHyprAdtagEmbedUrl(tagContent) {
  const src = String(tagContent || '');
  if (!src || !/data-hypr-adtag/i.test(src)) return null;
  const m = src.match(/data-iframe-src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  return m ? m[1] : null;
}
