import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const XANDR_API = "https://api.appnexus.com";
const MEMBER_ID = 14843;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getXandrToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const username = Deno.env.get("XANDR_USERNAME");
  const password = Deno.env.get("XANDR_PASSWORD");
  if (!username || !password) throw new Error("XANDR credentials not configured");
  const res = await fetch(`${XANDR_API}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: { username, password } }),
  });
  const data = await res.json();
  if (!data.response?.token) {
    throw new Error(`Xandr auth failed: ${data.response?.error || data.response?.error_message || JSON.stringify(data)}`);
  }
  cachedToken = data.response.token;
  tokenExpiry = Date.now() + 110 * 60 * 1000;
  return cachedToken!;
}

function detectPixelFormat(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith('<script') && !lower.includes('src=')) return 'raw-js';
  if (lower.endsWith('.js') || lower.includes('.js?') || lower.includes('/js/')) return 'url-js';
  if (lower.includes('.html')) return 'url-html';
  return 'url-image';
}

function normalizeTrackerInput(t: unknown): {url: string; format: string} {
  if (typeof t === 'string') return {url: t, format: detectPixelFormat(t)};
  const obj = t as {url?: string; format?: string};
  return {url: obj.url || '', format: obj.format || detectPixelFormat(obj.url || '')};
}

function wrapForXandr(tag: string): { content: string; originalContent: string } {
  let trimmed = tag.trim();
  while (trimmed.includes('\n')) trimmed = trimmed.split('\n').join(' ');
  while (trimmed.includes('  ')) trimmed = trimmed.split('  ').join(' ');
  if (trimmed.startsWith('document.write(') || trimmed.startsWith('var ') || trimmed.startsWith('(function')) {
    return { content: trimmed, originalContent: trimmed };
  }
  if (trimmed.startsWith('<')) {
    const withDoubleQuotes = trimmed.split("'").join('"');
    const scriptEscaped = withDoubleQuotes.split('<\/script>').join('<\\/script>').split('<\/SCRIPT>').join('<\\/script>');
    const escaped = scriptEscaped.split('"').join('\\"');
    let cleaned = escaped;
    while (cleaned.includes(' <\\\\/script>')) cleaned = cleaned.split(' <\\\\/script>').join('<\\\\/script>');
    while (cleaned.includes(' </ins>')) cleaned = cleaned.split(' </ins>').join('</ins>');
    const content = "document.write('" + cleaned + "');";
    return { content, originalContent: withDoubleQuotes };
  }
  return { content: trimmed, originalContent: trimmed };
}

function buildPixels(trackers: unknown[], globalPixel?: string): Array<{url: string; secure_url: string; format: string}> {
  const pixels: Array<{url: string; secure_url: string; format: string}> = [];
  const seen = new Set<string>();
  if (globalPixel) {
    seen.add(globalPixel);
    pixels.push({ url: globalPixel, secure_url: globalPixel.replace(/^http:/, 'https:'), format: detectPixelFormat(globalPixel) });
  }
  for (const t of trackers) {
    const n = normalizeTrackerInput(t);
    if (n.url && !seen.has(n.url)) {
      seen.add(n.url);
      pixels.push({ url: n.url, secure_url: n.url.replace(/^http:/, 'https:'), format: n.format });
    }
  }
  return pixels;
}

function buildVastTrackers(trackers: unknown[], globalPixel?: string): Array<{name: string; vast_event_type_id: number; url: string; secure_url: string}> {
  const result: Array<{name: string; vast_event_type_id: number; url: string; secure_url: string}> = [];
  const seen = new Set<string>();
  if (globalPixel && !seen.has(globalPixel)) { seen.add(globalPixel); result.push({name:'impression_tracker_0',vast_event_type_id:9,url:globalPixel,secure_url:globalPixel.replace(/^http:/,'https:')}); }
  for (const t of trackers) {
    const n = normalizeTrackerInput(t);
    if (n.url && !seen.has(n.url)) {
      seen.add(n.url);
      result.push({ name: `impression_tracker_${result.length}`, vast_event_type_id: 9, url: n.url, secure_url: n.url.replace(/^http:/, 'https:') });
    }
  }
  return result;
}

interface CreativeInput {
  name: string; width: number; height: number; jsTag: string; clickUrl?: string;
  type?: string; vastTag?: string; trackers?: unknown[];
  isPolitical?: boolean; languageId?: number; brandId?: number | null; brandUrl?: string | null; sla?: number;
}
interface CreativeResult {
  name: string; success: boolean; creativeId?: number; auditStatus?: string;
  creativeType?: string; error?: string; _input?: CreativeInput;
}

async function createXandrVastCreative(token: string, advertiserId: number, input: CreativeInput, globalPixel?: string): Promise<CreativeResult> {
  const vastUrl = input.vastTag || input.jsTag;
  const trackers = buildVastTrackers(input.trackers || [], globalPixel);
  const le: Record<string,unknown> = { vast_element_type_id: 1, name: "linear" }; if (trackers.length > 0) le.trackers = trackers;
  const auditUrl = input.brandUrl || "";
  // Use /creative endpoint (not /creative-vast) — /creative accepts landing_page_url + brand_url
  const creative: Record<string,unknown> = {
    name: input.name, advertiser_id: advertiserId, width: input.width || 1, height: input.height || 1,
    template: { id: 6439 },
    click_url: auditUrl, landing_page_url: auditUrl, brand_url: auditUrl,
    mobile: auditUrl ? { alternative_landing_page_url: auditUrl } : undefined,
    audit_status: "pending", allow_audit: true, allow_ssl_audit: true, is_self_audited: false, sla: input.sla || 0,
    video_attribute: { is_skippable: false, duration_ms: 30000,
      wrapper: { url: vastUrl, secure_url: vastUrl.replace(/^http:/, 'https:'), elements: [le] } },
  };
  if (input.languageId) creative.language = { id: input.languageId };
  if (input.brandId) creative.brand_id = input.brandId;
  if (input.isPolitical) creative.political = { is_political: true };
  try {
    const res = await fetch(`${XANDR_API}/creative?member_id=${MEMBER_ID}&advertiser_id=${advertiserId}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: token }, body: JSON.stringify({ creative }) });
    const data = await res.json();
    if (data.response?.status === "OK" && data.response?.creative) {
      return { name: input.name, success: true, creativeId: data.response.creative.id, auditStatus: data.response.creative.audit_status, creativeType: 'video', _input: input };
    }
    return { name: input.name, success: false, creativeType: 'video', error: data.response?.error_message || data.response?.error || JSON.stringify(data.response || data).substring(0, 500) };
  } catch (err) { return { name: input.name, success: false, creativeType: 'video', error: err instanceof Error ? err.message : String(err) }; }
}

async function createXandrDisplayCreative(token: string, advertiserId: number, input: CreativeInput, globalPixel?: string): Promise<CreativeResult> {
  const { content, originalContent } = wrapForXandr(input.jsTag);
  const pixels = buildPixels(input.trackers || [], globalPixel);
  const creative: Record<string, unknown> = {
    name: input.name, advertiser_id: advertiserId, width: input.width, height: input.height,
    template: { id: 6 }, content, content_secure: content, original_content: originalContent, original_content_secure: originalContent,
    click_url: "", landing_page_url: input.brandUrl || "", brand_url: input.brandUrl || "",
    mobile: input.brandUrl ? { alternative_landing_page_url: input.brandUrl } : undefined,
    audit_status: "pending", allow_audit: true, allow_ssl_audit: true, is_self_audited: false, sla: input.sla || 0,
  };
  if (input.languageId) creative.language = { id: input.languageId };
  if (input.brandId) creative.brand_id = input.brandId;
  if (pixels.length) creative.pixels = pixels;
  if (input.isPolitical) creative.political = { is_political: true };
  try {
    const res = await fetch(`${XANDR_API}/creative?member_id=${MEMBER_ID}&advertiser_id=${advertiserId}`,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: token }, body: JSON.stringify({ creative }) });
    const data = await res.json();
    if (data.response?.status === "OK" && data.response?.creative) {
      return { name: input.name, success: true, creativeId: data.response.creative.id, auditStatus: data.response.creative.audit_status, creativeType: 'display', _input: input };
    }
    return { name: input.name, success: false, creativeType: 'display', error: data.response?.error_message || data.response?.error || JSON.stringify(data.response || data).substring(0, 500) };
  } catch (err) { return { name: input.name, success: false, creativeType: 'display', error: err instanceof Error ? err.message : String(err) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Auth token missing" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return new Response(JSON.stringify({ error: "User not authenticated" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    const body = await req.json();
    const { advertiserId = 7392214, campaignName = "", advertiserName = "", brandName = "", sourceFilename = "", sourceType = "tags",
      creatives = [], trackingPixel = "", isPolitical = false, languageId = 8, brandId = null, brandUrl: rawBrandUrl = null, sla = 0,
    } = body as { advertiserId?: number; campaignName?: string; advertiserName?: string; brandName?: string; sourceFilename?: string; sourceType?: string;
      creatives: Array<{ name: string; dimensions: string; jsTag: string; clickUrl?: string; type?: string; vastTag?: string; trackers?: unknown[] }>;
      trackingPixel?: string; isPolitical?: boolean; languageId?: number; brandId?: number | null; brandUrl?: string | null; sla?: number; };

    if (!creatives.length) return new Response(JSON.stringify({ error: "No creatives provided" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    // Normalize brandUrl — ensure https:// prefix
    const brandUrl = rawBrandUrl && !/^https?:\/\//i.test(rawBrandUrl.trim()) ? 'https://' + rawBrandUrl.trim() : rawBrandUrl;

    const { data: batchData, error: batchError } = await supabase.from("creative_batches").insert({
      user_email: user.email, user_name: user.user_metadata?.full_name || user.email,
      source_type: sourceType === "surveys" ? "surveys" : sourceType === "assets" ? "assets" : "tags",
      campaign_name: campaignName || null, advertiser_name: advertiserName || null,
      brand_name: brandName || null, source_filename: sourceFilename || null,
      total_creatives: 0, dsps_activated: ["xandr"],
    }).select("id").single();
    const batchId = batchData?.id || null;
    if (batchError) console.error("Failed to create batch:", batchError.message);

    const t0 = Date.now();
    const token = await getXandrToken();
    const tAuth = Date.now();
    // Log auth step
    await supabase.from("activation_log").insert({
      user_email: user.email, dsp: "xandr", creatives_count: creatives.length, status: "info",
      step: "auth", duration_ms: tAuth - t0, edge_function: "dsp-xandr",
    }).then(() => {}, () => {});

    const results: CreativeResult[] = [];
    for (let i = 0; i < creatives.length; i += 5) {
      const batch = creatives.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map((c) => {
        const [w, h] = c.dimensions.split("x").map(Number);
        const input: CreativeInput = { name: c.name, width: w, height: h, jsTag: c.jsTag, clickUrl: c.clickUrl,
          type: c.type || 'display', vastTag: c.vastTag || '', trackers: c.trackers || [],
          isPolitical, languageId, brandId, brandUrl, sla };
        return c.type === 'video' ? createXandrVastCreative(token, advertiserId, input, trackingPixel)
          : createXandrDisplayCreative(token, advertiserId, input, trackingPixel);
      }));
      results.push(...batchResults);
    }

    const successResults = results.filter((r) => r.success && r._input);
    if (successResults.length > 0 && batchId) {
      const creativeRows = successResults.map((r) => {
        const inp = r._input!;
        const allTrackers: Array<{url:string;format:string}> = [];
        if (trackingPixel) allTrackers.push({url: trackingPixel, format: detectPixelFormat(trackingPixel)});
        if (inp.trackers) inp.trackers.forEach(t => { const n = normalizeTrackerInput(t); if (n.url) allTrackers.push(n); });
        return {
          batch_id: batchId, created_by_email: user.email!, created_by_name: user.user_metadata?.full_name || user.email,
          dsp: "xandr" as const, dsp_creative_id: String(r.creativeId), name: r.name,
          creative_type: r.creativeType === "video" ? "video" as const : "display" as const,
          dimensions: `${inp.width}x${inp.height}`,
          js_tag: inp.type === "video" ? null : inp.jsTag, vast_tag: inp.type === "video" ? (inp.vastTag || inp.jsTag) : null,
          click_url: inp.clickUrl || null, landing_page: inp.brandUrl || null,
          trackers: JSON.stringify(allTrackers),
          dsp_config: JSON.stringify({ member_id: MEMBER_ID, advertiser_id: advertiserId, language_id: languageId, brand_id: brandId, brand_url: brandUrl, sla, is_political: isPolitical }),
          status: "active", audit_status: r.auditStatus || "pending", last_synced_at: new Date().toISOString(),
        };
      });
      const { error: insertError } = await supabase.from("creatives").insert(creativeRows);
      if (insertError) console.error("Failed to insert creatives:", insertError.message);
      await supabase.from("creative_batches").update({ total_creatives: successResults.length }).eq("id", batchId);
    }

    const successCount = successResults.length;
    const status = successCount === results.length ? "success" : successCount > 0 ? "partial" : "error";
    await supabase.from("activation_log").insert({
      user_email: user.email, user_name: user.user_metadata?.full_name || user.email,
      dsp: "xandr", campaign_name: campaignName, advertiser_name: advertiserName, creatives_count: creatives.length, status,
      step: "complete", duration_ms: Date.now() - t0, edge_function: "dsp-xandr",
      request_payload: { advertiserId, creativesCount: creatives.length, isPolitical, languageId, brandId, brandUrl, sla, batchId },
      response_summary: { total: results.length, success: successCount, failed: results.length - successCount, batchId, creativeIds: results.filter((r) => r.success).map((r) => r.creativeId) },
      error_message: status === "error" ? results[0]?.error : null,
    });

    const cleanResults = results.map(({ _input, ...rest }) => rest);
    return new Response(JSON.stringify({ status, total: results.length, success: successCount, failed: results.length - successCount, batchId, results: cleanResults }), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
