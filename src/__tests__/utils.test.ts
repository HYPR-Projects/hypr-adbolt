import { describe, it, expect } from 'vitest';
import { cleanCR, normalizeUrl, extractBrand, formatBytes, extractTagClickUrl, isValidUrl } from '@/lib/utils';

describe('cleanCR', () => {
  it('removes _x000d_ artifacts', () => {
    expect(cleanCR('hello_x000d_world')).toBe('helloworld');
    expect(cleanCR('line_x000D_break')).toBe('linebreak');
  });

  it('removes carriage returns', () => {
    expect(cleanCR('line\r\nbreak')).toBe('line\nbreak');
  });

  it('handles clean strings', () => {
    expect(cleanCR('no artifacts here')).toBe('no artifacts here');
  });
});

describe('normalizeUrl', () => {
  it('prepends https:// to bare domains', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('www.example.com/path')).toBe('https://www.example.com/path');
  });

  it('leaves existing schemes alone', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('returns empty for empty input', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });

  it('does not prepend to non-domain strings', () => {
    expect(normalizeUrl('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

describe('extractBrand', () => {
  it('extracts brand from PUB_ pattern', () => {
    expect(extractBrand('PUB_HYPR_BR_LeroyMerlin', '')).toBe('LeroyMerlin');
    expect(extractBrand('PUB_ABC_US_Nike', '')).toBe('Nike');
  });

  it('falls back to campaign pipe pattern', () => {
    expect(extractBrand('', 'Campaign | BrandName')).toBe('BrandName');
  });

  it('returns advertiser as last resort', () => {
    expect(extractBrand('AdvertiserCo', 'NoPipe')).toBe('AdvertiserCo');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1KB');
    expect(formatBytes(400 * 1024)).toBe('400KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5MB');
  });
});

describe('extractTagClickUrl', () => {
  const HYPR_TAG = `<script src="mraid.js"></script>
<div data-hypr-adtag
  data-iframe-src="https://platform.hypr.mobi/share/creatives/zbq5fbc6ni3wwc"
  data-width="300"
  data-height="250"
  data-clicktag="\${CLICK_URL}"
  data-cb="\${CACHEBUSTER}"
  data-meta-dv360="su=\${SOURCE_URL_ENC};ioid=\${INSERTION_ORDER_ID};cid=\${CAMPAIGN_ID};aid=\${AUCTION_ID};pid=\${PUBLISHER_ID};bid=\${BUNDLE_ID};creid=\${CREATIVE_ID};gdpr=\${GDPR};gdprc=\${GDPR_CONSENT_755}"
  data-meta-xandr="aid=\${AUCTION_ID};tid=\${TAG_ID};sid=\${SITE_ID};pid=\${PUBLISHER_ID};cpid=\${CP_ID};ioid=\${IO_ID};ref=\${REFERER_URL_ENC};st=\${SUPPLY_TYPE};gdpr=\${GDPR};gdprc=\${GDPR_CONSENT}"></div>
<script src="https://platform.hypr.mobi/hypr-adtag.js" async></script>`;

  it('extracts data-iframe-src from a HYPR adtag (no literal landing in tag)', () => {
    expect(extractTagClickUrl(HYPR_TAG)).toBe('https://platform.hypr.mobi/share/creatives/zbq5fbc6ni3wwc');
  });

  it('never returns the ${CLICK_URL} macro as a click URL', () => {
    const url = extractTagClickUrl(HYPR_TAG);
    expect(url).not.toContain('${');
    expect(isValidUrl(url)).toBe(true);
  });

  it('prefers data-cta-url over HYPR iframe-src', () => {
    const tag = '<div data-hypr-adtag data-cta-url="https://cliente.com/lp" data-iframe-src="https://platform.hypr.mobi/share/creatives/abc"></div>';
    expect(extractTagClickUrl(tag)).toBe('https://cliente.com/lp');
  });

  it('does not use iframe-src on non-HYPR tags', () => {
    const tag = '<iframe data-iframe-src="https://random.com/x"></iframe>';
    expect(extractTagClickUrl(tag)).toBe('');
  });

  it('still extracts plain href URLs', () => {
    const tag = '<a href="https://example.org/landing">x</a>';
    expect(extractTagClickUrl(tag)).toBe('https://example.org/landing');
  });

  it('returns empty for empty tag', () => {
    expect(extractTagClickUrl('')).toBe('');
  });
});
