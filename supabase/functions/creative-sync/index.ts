import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64url } from "https://deno.land/std@0.208.0/encoding/base64url.ts";

const XANDR_API = "https://api.appnexus.com";
const MEMBER_ID = 14843;
const DV360_API = "https://displayvideo.googleapis.com/v4";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizeAuditStatus(dsp: string, rawStatus: string): string {
  const s = (rawStatus || "").toLowerCase().trim();
  if (dsp === "xandr") {
    if (s === "audited") return "approved";
    if (s === "pending" || s === "no_audit") return "pending";
    if (s === "rejected") return "rejected";
    return "unknown";
  }
  if (dsp === "dv360") {
    if (s.includes("approved") && !s.includes("pending") && !s.includes("not_servable")) return "approved";
    if (s.includes("pending") || s.includes("not_servable") || s === "pending") return "pending";
    if (s.includes("rejected") || s.includes("disapproved")) return "rejected";
    if (s === "approval_status_unspecified") return "pending";
    return "unknown";
  }
  return "unknown";
}

function normalizeExchangeName(exchange: string): string {
  const map: Record<string, string> = {
    "EXCHANGE_GOOGLE_AD_MANAGER": "Google Ad Manager", "EXCHANGE_APPNEXUS": "Microsoft Monetize",
    "EXCHANGE_OPEN_X": "OpenX", "EXCHANGE_PUBMATIC": "PubMatic", "EXCHANGE_INDEX": "Index Exchange",
    "EXCHANGE_RUBICON": "Magnite", "EXCHANGE_SMART_CLIP": "SmartClip", "EXCHANGE_ADFORM": "Adform",
    "EXCHANGE_IMPROVE_DIGITAL": "Improve Digital", "EXCHANGE_MEDIAMATH": "Infillion",
    "EXCHANGE_SMAATO": "Smaato", "EXCHANGE_FREEWHEEL": "FreeWheel", "EXCHANGE_TRIPLELIFT": "TripleLift",
    "EXCHANGE_YIELDMO": "Yieldmo", "EXCHANGE_SUPERSHIP": "Supership", "EXCHANGE_NEND": "nend",
    "EXCHANGE_COMCAST": "Comcast", "EXCHANGE_TEADS": "Teads", "EXCHANGE_OUTBRAIN": "Outbrain",
    "EXCHANGE_TABOOLA": "Taboola"
  };
  return map[exchange] || exchange.replace(/^EXCHANGE_/, "").replace(/_/g, " ");
}

function normalizeExchangeStatus(status: string): string {
  const s = (status || "").toUpperCase();
  if (s.includes("APPROVED") || s === "REVIEW_STATUS_APPROVED") return "approved";
  if (s.includes("PENDING") || s === "REVIEW_STATUS_UNSPECIFIED") return "pending";
  if (s.includes("REJECTED") || s.includes("DISAPPROVED")) return "rejected";
  return "pending";
}

let cachedXandrToken: string | null = null;
let xandrTokenExpiry = 0;
async function getXandrToken(): Promise<string> {
  if (cachedXandrToken && Date.now() < xandrTokenExpiry) return cachedXandrToken;
  const u = Deno.env.get("XANDR_USERNAME"), p = Deno.env.get("XANDR_PASSWORD");
  if (!u || !p) throw new Error("XANDR credentials not configured");
  const r = await fetch(`${XANDR_API}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: { username: u, password: p } }) });
  const d = await r.json();
  if (!d.response?.token) throw new Error(`Xandr auth failed: ${JSON.stringify(d)}`);
  cachedXandrToken = d.response.token; xandrTokenExpiry = Date.now() + 110 * 60 * 1000;
  return cachedXandrToken!;
}

let cachedDV360Token: string | null = null;
let dv360TokenExpiry = 0;
async function importPKCS8(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\\n/g, "").replace(/\n/g, "").replace(/\s/g, "");
  return crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(b), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function getDV360Token(): Promise<string> {
  if (cachedDV360Token && Date.now() < dv360TokenExpiry) return cachedDV360Token;
  const raw = Deno.env.get("DV360_SERVICE_ACCOUNT_KEY");
  if (!raw) throw new Error("DV360_SERVICE_ACCOUNT_KEY not configured");
  const sa = JSON.parse(raw), now = Math.floor(Date.now() / 1000), enc = new TextEncoder();
  const hB = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const pB = base64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/display-video", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const si = `${hB}.${pB}`, key = await importPKCS8(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(si));
  const jwt = `${si}.${base64url(new Uint8Array(sig))}`;
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const td = await tr.json();
  if (!td.access_token) throw new Error(`Google OAuth failed: ${JSON.stringify(td)}`);
  cachedDV360Token = td.access_token; dv360TokenExpiry = Date.now() + (td.expires_in - 60) * 1000;
  return cachedDV360Token!;
}

async function fetchXandrAudit(token: string, ids: string[], advId: number) {
  const m = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100).join(",");
    try {
      const r = await fetch(`${XANDR_API}/creative?id=${batch}&member_id=${MEMBER_ID}&advertiser_id=${advId}`, { headers: { Authorization: token } });
      const d = await r.json();
      for (const c of (d.response?.creatives || (d.response?.creative ? [d.response.creative] : [])))
        m.set(String(c.id), normalizeAuditStatus("xandr", c.audit_status || ""));
    } catch (e) { console.error("Xandr batch error:", e); }
  }
  const vast = ids.filter(id => !m.has(id));
  for (let i = 0; i < vast.length; i += 100) {
    const batch = vast.slice(i, i + 100).join(",");
    try {
      const r = await fetch(`${XANDR_API}/creative-vast?id=${batch}&member_id=${MEMBER_ID}&advertiser_id=${advId}`, { headers: { Authorization: token } });
      const d = await r.json();
      for (const c of (d.response?.["creative-vasts"] || (d.response?.["creative-vast"] ? [d.response["creative-vast"]] : [])))
        m.set(String(c.id), normalizeAuditStatus("xandr", c.audit_status || ""));
    } catch (e) { console.error("Xandr VAST batch error:", e); }
  }
  return m;
}

interface DV360AuditInfo { status: string; entityStatus?: string; exchangeStatuses?: Array<{ exchange: string; status: string }>; }

async function fetchDV360AuditBatch(token: string, ids: string[], advId: string): Promise<Map<string, DV360AuditInfo>> {
  const m = new Map<string, DV360AuditInfo>();
  const BATCH = 20;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const filter = batch.map(id => `creativeId=${id}`).join(" OR ");
    try {
      let pageToken = "";
      do {
        const params = new URLSearchParams({ pageSize: "200", filter, ...(pageToken ? { pageToken } : {}) });
        const r = await fetch(`${DV360_API}/advertisers/${advId}/creatives?${params}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        if (d.creatives) {
          for (const c of d.creatives) {
            const rawExchanges = c.reviewStatus?.exchangeReviewStatuses || [];
            const exchangeStatuses = rawExchanges.map((er: any) => ({ exchange: normalizeExchangeName(er.exchange || ""), status: normalizeExchangeStatus(er.status || "") }));
            m.set(c.creativeId, { status: normalizeAuditStatus("dv360", c.reviewStatus?.approvalStatus || "PENDING"), entityStatus: c.entityStatus || "", exchangeStatuses });
          }
        }
        pageToken = d.nextPageToken || "";
      } while (pageToken);
    } catch (e) { console.error("DV360 list batch error:", e); }
  }
  return m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  try {
    const ah = req.headers.get("authorization");
    if (!ah?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Auth token missing" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user }, error: ae } = await sb.auth.getUser(ah.replace("Bearer ", ""));
    if (ae || !user) return new Response(JSON.stringify({ error: "User not authenticated" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    const body = await req.json().catch(() => ({}));
    const { batchId, dsp, creativeIds: specificIds } = body as { batchId?: string; dsp?: string; creativeIds?: string[] };
    let q = sb.from("creatives").select("id, dsp, dsp_creative_id, dsp_config, audit_status, creative_type, status").in("status", ["active", "error"]);
    if (specificIds?.length) q = q.in("id", specificIds);
    else if (batchId) q = q.eq("batch_id", batchId);
    if (dsp) q = q.eq("dsp", dsp);

    const { data: creatives, error: qe } = await q.limit(500);
    if (qe) return new Response(JSON.stringify({ error: qe.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    if (!creatives?.length) return new Response(JSON.stringify({ message: "No creatives to sync", synced: 0 }), { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    const xc = creatives.filter(c => c.dsp === "xandr");
    const dc = creatives.filter(c => c.dsp === "dv360");
    let updated = 0, deleted = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const now = () => new Date().toISOString();

    if (xc.length > 0) {
      try {
        const token = await getXandrToken();
        const byAdv = new Map<number, typeof xc>();
        for (const c of xc) { const cfg = typeof c.dsp_config === "string" ? JSON.parse(c.dsp_config) : (c.dsp_config || {}); const a = cfg.advertiser_id || 7392214; if (!byAdv.has(a)) byAdv.set(a, []); byAdv.get(a)!.push(c); }
        for (const [advId, acs] of byAdv) {
          const sm = await fetchXandrAudit(token, acs.map(c => c.dsp_creative_id), advId);
          for (const c of acs) {
            const remote = sm.get(c.dsp_creative_id);
            if (remote) {
              if (remote !== c.audit_status) { await sb.from("creatives").update({ audit_status: remote, last_synced_at: now(), sync_error: null }).eq("id", c.id).eq("status", "active"); updated++; }
              else { await sb.from("creatives").update({ last_synced_at: now(), sync_error: null }).eq("id", c.id).eq("status", "active"); }
            } else { await sb.from("creatives").update({ status: "deleted", audit_status: "deleted", sync_error: "Deleted from Xandr", last_synced_at: now() }).eq("id", c.id).eq("status", "active"); deleted++; }
          }
        }
      } catch (err) { const m = err instanceof Error ? err.message : String(err); for (const c of xc) errors.push({ id: c.id, error: m }); }
    }

    if (dc.length > 0) {
      try {
        const token = await getDV360Token();
        const byAdv = new Map<string, typeof dc>();
        for (const c of dc) { const cfg = typeof c.dsp_config === "string" ? JSON.parse(c.dsp_config) : (c.dsp_config || {}); const a = String(cfg.advertiser_id || Deno.env.get("DV360_ADVERTISER_ID") || "1426474713"); if (!byAdv.has(a)) byAdv.set(a, []); byAdv.get(a)!.push(c); }
        for (const [advId, acs] of byAdv) {
          const sm = await fetchDV360AuditBatch(token, acs.map(c => c.dsp_creative_id), advId);
          for (const c of acs) {
            const info = sm.get(c.dsp_creative_id);
            if (info) {
              const existingConfig = typeof c.dsp_config === "string" ? JSON.parse(c.dsp_config) : (c.dsp_config || {});
              const updatedConfig = { ...existingConfig, exchangeReviewStatuses: info.exchangeStatuses };
              if (info.entityStatus === "ENTITY_STATUS_ARCHIVED") { await sb.from("creatives").update({ status: "deleted", audit_status: "archived", dsp_config: updatedConfig, sync_error: null, last_synced_at: now() }).eq("id", c.id).eq("status", "active"); deleted++; }
              else if (info.status !== c.audit_status) { await sb.from("creatives").update({ audit_status: info.status, dsp_config: updatedConfig, last_synced_at: now(), sync_error: null }).eq("id", c.id).eq("status", "active"); updated++; }
              else { await sb.from("creatives").update({ dsp_config: updatedConfig, last_synced_at: now(), sync_error: null }).eq("id", c.id).eq("status", "active"); }
            } else { await sb.from("creatives").update({ sync_error: "Not found in DV360", last_synced_at: now() }).eq("id", c.id).eq("status", "active"); errors.push({ id: c.id, error: "Not found in DV360" }); }
          }
        }
      } catch (err) { const m = err instanceof Error ? err.message : String(err); for (const c of dc) errors.push({ id: c.id, error: m }); }
    }

    return new Response(JSON.stringify({ synced: creatives.length, updated, deleted, xandr: xc.length, dv360: dc.length, errors: errors.length ? errors : undefined }), { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
