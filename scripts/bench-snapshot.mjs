// Snapshot perf benchmark — usage: BROWSERBASE_API_KEY=... node scripts/bench-snapshot.mjs <pageUrl>
import { runSnapshot } from '../api/snapshot.js';
const TAG = `<script src="mraid.js"></script> <div data-hypr-adtag data-iframe-src="https://platform.hypr.mobi/share/creatives/rcmpayjbzm4b6m" data-width="300" data-height="600" data-clicktag="\${CLICK_URL}" data-cb="\${CACHEBUSTER}"></div> <script src="https://platform.hypr.mobi/hypr-adtag.js" async></script>`;
const url = process.argv[2] || 'https://www.tudogostoso.com.br/';
const t0 = Date.now();
const r = await runSnapshot({ url, creativeUrl: TAG, creativeSize: '300x600', creativeKind: 'tag', freeze: false, proxies: false });
await (await import('fs')).promises.writeFile('/tmp/snap-out.html', r.html); console.log(JSON.stringify({ total_s: ((Date.now()-t0)/1000).toFixed(1), phases: r.meta.phases, cache: r.meta.cacheStats, htmlKB: Math.round(r.html.length/1024), filled: r.slots.filled, live: r.meta.live }));
