// Returns JSON { image, click } extracted from the CM360 ad server response.
// Consumer is the React component, which renders <img>/<a> directly.

export const config = { runtime: 'edge' };

const AD_HOST = 'ad.doubleclick.net';

export default async function handler(request) {
  const url = new URL(request.url);
  const placement = url.searchParams.get('placement');
  const size = url.searchParams.get('sz') || '300x250';
  const ord = url.searchParams.get('ord') || String(Math.floor(Math.random() * 1e13));

  if (!placement || !/^[A-Za-z0-9._/-]+$/.test(placement)) {
    return Response.json({ error: 'invalid placement' }, { status: 400 });
  }
  if (!/^\d{1,4}x\d{1,4}$/.test(size)) {
    return Response.json({ error: 'invalid size' }, { status: 400 });
  }

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
    if (!r.ok) {
      return Response.json({ error: `ad server ${r.status}` }, { status: 200, headers: noStore() });
    }
    adHtml = await r.text();
  } catch (err) {
    return Response.json({ error: 'fetch failed: ' + String(err) }, { status: 200, headers: noStore() });
  }

  const imgMatch = adHtml.match(/https:\/\/s0\.2mdn\.net\/simgad\/\d+/);
  const richMatch = adHtml.match(/https:\/\/s0\.2mdn\.net\/creatives\/[A-Za-z0-9_\-\/]+\.(?:png|jpg|jpeg|gif|webp)/i);
  const image = imgMatch ? imgMatch[0] : (richMatch ? richMatch[0] : null);

  const clickMatch = adHtml.match(/https:\/\/adclick\.g\.doubleclick\.net\/pcs\/click\?[^"'\s<>\\]+/);
  const click = clickMatch ? clickMatch[0].replace(/&amp;/g, '&') : null;

  if (!image) {
    return Response.json({ error: 'no image in ad response' }, { status: 200, headers: noStore() });
  }

  return Response.json({ image, click }, { headers: noStore() });
}

function noStore() {
  return {
    'cache-control': 'no-store, no-cache, must-revalidate',
    'access-control-allow-origin': '*',
  };
}
