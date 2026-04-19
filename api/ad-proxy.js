// Proxies the CM360 ad server, parses the HTML it returns, and sends back a
// minimal <img>+<a> document. Why: the raw ad-server HTML is loaded with
// tracking, Active View, DoubleVerify, sub-iframes, postMessage handshakes —
// all of that was what caused the 2nd+ preview open to break in Chrome, and
// none of it is needed for a creative preview. The asset is a public image
// with open CORS; clicking should open the landing page. That is it.
//
// First open: proxy fetches the ad-server HTML, finds the image URL and the
//   click-through URL, builds a trivial document, streams it back.
// Any subsequent open: same process, fresh ord on the server side, fresh
//   parsing. The iframe that our page loads is always a tiny HTML document
//   served from adbolt.hypr.mobi with no scripts and no cross-origin ads —
//   there is nothing the browser can dedupe or partition here.

export const config = {
  runtime: 'edge',
};

const AD_HOST = 'ad.doubleclick.net';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPreviewDoc(imageUrl, clickUrl, width, height, note) {
  const img = escapeHtml(imageUrl);
  const click = clickUrl ? escapeHtml(clickUrl) : null;
  const w = width;
  const h = height;
  const body = click
    ? `<a href="${click}" target="_blank" rel="noopener noreferrer"><img src="${img}" width="${w}" height="${h}" alt=""></a>`
    : `<img src="${img}" width="${w}" height="${h}" alt="">`;
  const warning = note
    ? `<div style="position:absolute;left:0;right:0;bottom:0;background:rgba(180,120,0,0.9);color:#fff;padding:3px 6px;font:10px ui-monospace,monospace;">${escapeHtml(note)}</div>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:transparent}
a,img{display:block;width:${w}px;height:${h}px;border:0}
img{object-fit:contain}
</style></head><body>${body}${warning}</body></html>`;
}

function buildErrorDoc(msg, w, h) {
  const m = escapeHtml(msg);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;background:#2a1010;color:#fca;font:11px ui-monospace,monospace;text-align:center;padding:8px}
</style></head><body>Preview indisponível<br>${m}</body></html>`;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const placement = url.searchParams.get('placement');
  const size = url.searchParams.get('sz') || '300x250';
  const ord = url.searchParams.get('ord') || String(Math.floor(Math.random() * 1e13));

  if (!placement || !/^[A-Za-z0-9._/-]+$/.test(placement)) {
    return new Response('invalid placement', { status: 400 });
  }
  if (!/^(\d{1,4})x(\d{1,4})$/.test(size)) {
    return new Response('invalid size', { status: 400 });
  }
  const [w, h] = size.split('x').map(Number);

  const adUrl = `https://${AD_HOST}/ddm/adi/${placement};sz=${size};ord=${ord}?`;

  let adHtml;
  try {
    const r = await fetch(adUrl, {
      headers: {
        'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    adHtml = await r.text();
  } catch (err) {
    return new Response(buildErrorDoc('fetch failed', w, h), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // Extract creative image (asset CDN)
  const imgMatch = adHtml.match(/https:\/\/s0\.2mdn\.net\/simgad\/\d+/);
  // Also try the creatives subpath used by richer formats
  const richMatch = adHtml.match(/https:\/\/s0\.2mdn\.net\/creatives\/[A-Za-z0-9_\-\/]+\.(?:png|jpg|jpeg|gif|webp)/i);
  const imageUrl = imgMatch ? imgMatch[0] : (richMatch ? richMatch[0] : null);

  // Extract click URL. CM360 wraps the landing page inside adclick.g.doubleclick.net.
  const clickMatch = adHtml.match(/https:\/\/adclick\.g\.doubleclick\.net\/pcs\/click\?[^"'\s<>\\]+/);
  const clickUrl = clickMatch ? clickMatch[0].replace(/&amp;/g, '&') : null;

  if (!imageUrl) {
    // Fallback: return the raw ad-server HTML so at least dcmads/creative
    // mode tags that are not plain image still have a chance. This is the
    // failure path we are trying to leave behind, but returning raw HTML is
    // still better than an empty frame.
    return new Response(adHtml, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  }

  const doc = buildPreviewDoc(imageUrl, clickUrl, w, h, null);
  return new Response(doc, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-frame-options': 'SAMEORIGIN',
    },
  });
}
