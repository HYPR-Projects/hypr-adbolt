// GET /api/vast-resolve?url=<vast-tag-url>
// Resolves a VAST tag to a directly playable progressive MP4, server-side
// (browsers can't fetch adserver VAST XML directly — no CORS headers), and
// WITHOUT firing impression/quartile beacons (no VAST player involved).
// Used by the wizard's creative preview for video placements.

import { resolveVastMediaFile } from './_lib/vast.js';

// Basic SSRF guard: only public https URLs, no IP literals / localhost.
function isAllowedVastUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (host.includes(':')) return false; // IPv6 literal
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const url = String(req.query?.url || '').trim();
  if (!url || !isAllowedVastUrl(url)) {
    return res.status(400).json({ error: 'invalid_url' });
  }

  try {
    const mp4 = await resolveVastMediaFile(url);
    // The MP4 for a given creative is stable; cache at the edge to keep
    // repeated previews instant and spare the adserver.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    if (!mp4) {
      return res.status(200).json({ url: null, error: 'no_progressive_mp4' });
    }
    return res.status(200).json({ url: mp4 });
  } catch (err) {
    return res.status(200).json({ url: null, error: 'resolve_failed' });
  }
}
