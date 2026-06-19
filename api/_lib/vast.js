// Resolve a VAST tag (URL or inline XML) to a directly playable MP4 MediaFile.
// We extract the MediaFile and play it in a plain <video>, deliberately NOT
// running the VAST through a player (IMA): a serving VAST played live would
// fire Impression + quartile beacons on every open and pollute the campaign's
// delivery. Extracting the MediaFile shows the real video without firing them.
//
// Resolution chain (each step bounded; up to 4 hops total):
//   1. URL → fetch XML (macros filled, 6s timeout)
//   2. InLine with progressive MP4 MediaFile → done
//   3. Wrapper → follow <VASTAdTagURI>
//   4. VPAID-only InLine (DCM pattern) → the real VAST is HTML-entity-encoded
//      inside <AdParameters>; decode and recurse. Covers CM360 in-stream
//      creatives wrapped by verification vendors (DoubleVerify/IAS), where the
//      outer serve exposes only the VPAID adapter JS.
//
// Shared by api/snapshot.js (checkin) and api/vast-resolve.js (wizard preview).

export function fillVastMacros(u) {
  const ts = Date.now();
  const cb = Math.floor(Math.random() * 1e12);
  return String(u)
    .replace(/\[(?:TIMESTAMP|timestamp)\]/g, String(ts))
    .replace(/\[(?:CACHEBUSTING|CACHEBUSTER|cachebuster|random|RANDOM)\]/g, String(cb))
    .replace(/%%CACHEBUSTER%%/g, String(cb));
}

export function pickMp4FromVast(xml) {
  // Grab every <MediaFile ...>URL</MediaFile>, keep progressive MP4s.
  const files = [];
  const re = /<MediaFile\b([^>]*)>([\s\S]*?)<\/MediaFile>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const url = (m[2] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
    const api = (attrs.match(/\bapiFramework\s*=\s*["']([^"']+)["']/i) || [, ''])[1].toLowerCase();
    const width = parseInt((attrs.match(/\bwidth\s*=\s*["'](\d+)["']/i) || [, '0'])[1], 10) || 0;
    if (api === 'vpaid') continue; // not playable in a plain <video>
    const isMp4 = type.includes('mp4') || /\.mp4(\?|$)/i.test(url);
    if (isMp4) files.push({ url, width });
  }
  if (!files.length) return null;
  // Prefer the largest MP4 not wider than 1280 (good quality, light); else the
  // smallest available.
  const capped = files.filter((f) => f.width && f.width <= 1280).sort((a, b) => b.width - a.width);
  if (capped.length) return capped[0].url;
  return files.sort((a, b) => (a.width || 9999) - (b.width || 9999))[0].url;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function resolveVastMediaFile(vast, hops = 0) {
  if (!vast || hops > 4) return null;
  let xml = String(vast).trim();
  try {
    if (/^https?:\/\//i.test(xml)) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      let r;
      try {
        r = await fetch(fillVastMacros(xml), {
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/xml,text/xml,*/*' },
        });
      } finally { clearTimeout(t); }
      if (!r.ok) return null;
      xml = await r.text();
    }
    if (!/<VAST|<MediaFile|<VASTAdTagURI/i.test(xml)) return null;
    // Inline ad with a MediaFile → done.
    const mp4 = pickMp4FromVast(xml);
    if (mp4) return mp4;
    // Wrapper → follow the next VASTAdTagURI.
    const wrap = xml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
    if (wrap) {
      const next = wrap[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (/^https?:\/\//i.test(next)) return resolveVastMediaFile(next, hops + 1);
    }
    // VPAID-only serve (DCM): the playable VAST is entity-encoded inside
    // <AdParameters>. Decode and keep resolving from there.
    const ap = xml.match(/<AdParameters[^>]*>([\s\S]*?)<\/AdParameters>/i);
    if (ap) {
      const inner = decodeHtmlEntities(ap[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
      if (/<VAST|<MediaFile|<VASTAdTagURI/i.test(inner)) {
        return resolveVastMediaFile(inner, hops + 1);
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Resolve a VAST tag (URL or inline XML) to the INLINE ad XML — following
// wrappers to the ad that actually carries the MediaFile/Duration/ClickThrough.
// Used by the tag linter preflight (rule 4) to inspect VAST content without
// running a player (no Impression/quartile beacons fired). Mirrors the hop
// logic of resolveVastMediaFile but returns the XML string instead of the MP4.
export async function resolveVastInlineXml(vast, hops = 0) {
  if (!vast || hops > 4) return null;
  let xml = String(vast).trim();
  try {
    if (/^https?:\/\//i.test(xml)) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      let r;
      try {
        r = await fetch(fillVastMacros(xml), {
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/xml,text/xml,*/*' },
        });
      } finally { clearTimeout(t); }
      if (!r.ok) return null;
      xml = await r.text();
    }
    if (!/<VAST|<MediaFile|<VASTAdTagURI/i.test(xml)) return null;
    // Inline ad (has a MediaFile) → this is the content to inspect.
    if (/<MediaFile\b/i.test(xml)) return xml;
    // Wrapper → follow the next VASTAdTagURI.
    const wrap = xml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/i);
    if (wrap) {
      const next = wrap[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (/^https?:\/\//i.test(next)) {
        const deeper = await resolveVastInlineXml(next, hops + 1);
        if (deeper) return deeper;
      }
    }
    // VPAID-only serve (DCM): real VAST is entity-encoded in <AdParameters>.
    const ap = xml.match(/<AdParameters[^>]*>([\s\S]*?)<\/AdParameters>/i);
    if (ap) {
      const inner = decodeHtmlEntities(ap[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
      if (/<VAST|<MediaFile|<VASTAdTagURI/i.test(inner)) {
        return resolveVastInlineXml(inner, hops + 1);
      }
    }
    // No deeper inline found — return what we have so the linter can still
    // flag missing MediaFile/Duration rather than silently passing.
    return xml;
  } catch (e) {
    return null;
  }
}
