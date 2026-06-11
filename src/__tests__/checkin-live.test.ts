import { describe, it, expect } from 'vitest';
import { resolveHyprAdtagEmbedUrl } from '../../api/_checkin/live.js';

const HYPR_TAG = `<script src="mraid.js"></script> <div data-hypr-adtag data-iframe-src="https://platform.hypr.mobi/share/creatives/rcmpayjbzm4b6m" data-width="300" data-height="600" data-clicktag="\${CLICK_URL}" data-cb="\${CACHEBUSTER}" data-meta-dv360="su=\${SOURCE_URL_ENC};gdpr=\${GDPR}" data-meta-xandr="aid=\${AUCTION_ID}"></div> <script src="https://platform.hypr.mobi/hypr-adtag.js" async></script>`;

describe('resolveHyprAdtagEmbedUrl', () => {
  it('resolves the hosted creative URL from a HYPR adtag (real production tag)', () => {
    expect(resolveHyprAdtagEmbedUrl(HYPR_TAG)).toBe('https://platform.hypr.mobi/share/creatives/rcmpayjbzm4b6m');
  });

  it('returns the URL bare — no delivery params appended (non-billable contract)', () => {
    const url = resolveHyprAdtagEmbedUrl(HYPR_TAG);
    expect(url).not.toMatch(/[?&](dlv|clicktag|cb)=/);
  });

  it('returns null for CM360 tags (must stay frozen — billable)', () => {
    const cm360 = '<ins class="dcmads" data-dcm-placement="N1014735.3844866HYPR/B35939394"><script src="https://www.googletagservices.com/dcm/dcmads.js"></script></ins>';
    expect(resolveHyprAdtagEmbedUrl(cm360)).toBeNull();
  });

  it('returns null for generic iframe tags without data-hypr-adtag', () => {
    expect(resolveHyprAdtagEmbedUrl('<iframe src="https://ad.example.com/x"></iframe>')).toBeNull();
  });

  it('returns null when the HYPR adtag has no http(s) iframe-src', () => {
    expect(resolveHyprAdtagEmbedUrl('<div data-hypr-adtag data-iframe-src="//broken"></div>')).toBeNull();
  });

  it('returns null for empty/undefined input', () => {
    expect(resolveHyprAdtagEmbedUrl('')).toBeNull();
    expect(resolveHyprAdtagEmbedUrl(undefined)).toBeNull();
  });

  it('accepts single-quoted attributes', () => {
    expect(resolveHyprAdtagEmbedUrl("<div data-hypr-adtag data-iframe-src='https://platform.hypr.mobi/share/creatives/abc123'></div>"))
      .toBe('https://platform.hypr.mobi/share/creatives/abc123');
  });
});
