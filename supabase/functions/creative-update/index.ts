import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getDV360Token, DV360_API } from "../_shared/dv360-auth.ts";

const XANDR_API = "https://api.appnexus.com";
const MEMBER_ID = 14843;
const CORS_HEADERS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, content-type, x-client-info, apikey","Access-Control-Allow-Methods":"POST, OPTIONS"};

let cachedXandrToken: string | null = null;
let xandrTokenExpiry = 0;
async function getXandrToken(): Promise<string> {
  if (cachedXandrToken && Date.now() < xandrTokenExpiry) return cachedXandrToken;
  const u = Deno.env.get("XANDR_USERNAME"), p = Deno.env.get("XANDR_PASSWORD");
  if (!u || !p) throw new Error("XANDR credentials not configured");
  const r = await fetch(`${XANDR_API}/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: { username: u, password: p } }) });
  const d = await r.json();
  if (!d.response?.token) throw new Error(`Xandr auth failed`);
  cachedXandrToken = d.response.token; xandrTokenExpiry = Date.now() + 110 * 60 * 1000;
  return cachedXandrToken!;
}

const XANDR_EDITABLE = new Set(["name", "click_url", "landing_page", "trackers"]);
const DV360_EDITABLE = new Set(["name", "landing_page", "trackers", "vast_tag"]);

function detectPixelFormat(url: string): string {
  const l = url.toLowerCase();
  if (l.includes('.js')) return 'url-js';
  return 'url-image';
}

function buildAppendedTag(urls: string[]): string {
  return urls.map(u => u.toLowerCase().includes('.js')
    ? '<script src="' + u + '"></' + 'script>'
    : '<img src="' + u + '" width="1" height="1" style="display:none"/>'
  ).join('\n');
}

async function updateXandrCreative(dspCreativeId: string, creativeType: string, dspConfig: Record<string, unknown>, changes: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const token = await getXandrToken();
  const advId = dspConfig.advertiser_id || 7392214;
  const payload: Record<string, unknown> = {};
  if (changes.name !== undefined) payload.name = changes.name;
  if (changes.click_url !== undefined) payload.click_url = changes.click_url;
  if (changes.landing_page !== undefined) payload.landing_page_url = changes.landing_page;
  if (changes.trackers !== undefined) {
    const urls = changes.trackers as string[];
    payload.pixels = urls.length > 0 ? urls.slice(0, 5).map(u => ({ url: u, secure_url: u.replace(/^http:/, 'https:'), format: detectPixelFormat(u) })) : null;
  }
  if (Object.keys(payload).length === 0) return { success: true };
  const isVast = creativeType === "video";
  const endpoint = isVast
    ? `${XANDR_API}/creative-vast?id=${dspCreativeId}&member_id=${MEMBER_ID}&advertiser_id=${advId}`
    : `${XANDR_API}/creative?id=${dspCreativeId}&member_id=${MEMBER_ID}&advertiser_id=${advId}`;
  const bodyKey = isVast ? "creative-vast" : "creative";
  const res = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: token }, body: JSON.stringify({ [bodyKey]: payload }) });
  const data = await res.json();
  if (data.response?.status === "OK") return { success: true };
  return { success: false, error: data.response?.error_message || data.response?.error || JSON.stringify(data).substring(0, 500) };
}

async function updateDV360Creative(dspCreativeId: string, creativeType: string, isHosted: boolean, dspConfig: Record<string, unknown>, changes: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getDV360Token();
  const advId = dspConfig.advertiser_id || Deno.env.get("DV360_ADVERTISER_ID") || "1426474713";
  const payload: Record<string, unknown> = {};
  const updateMask: string[] = [];

  if (changes.name !== undefined) {
    payload.displayName = changes.name;
    updateMask.push("displayName");
  }

  if (changes.landing_page !== undefined && creativeType !== "video") {
    payload.exitEvents = [{ type: "EXIT_EVENT_TYPE_DEFAULT", url: changes.landing_page }];
    updateMask.push("exitEvents");
  }

  if (changes.trackers !== undefined && creativeType !== "video") {
    const urls = changes.trackers as string[];
    if (isHosted) {
      payload.appendedTag = urls.length > 0 ? buildAppendedTag(urls) : "";
      updateMask.push("appendedTag");
    } else {
      payload.thirdPartyUrls = urls.map(u => ({ type: "THIRD_PARTY_URL_TYPE_IMPRESSION", url: u }));
      updateMask.push("thirdPartyUrls");
    }
  }

  if (changes.vast_tag !== undefined && creativeType === "video") {
    payload.vastTagUrl = changes.vast_tag;
    updateMask.push("vastTagUrl");
  }

  if (updateMask.length === 0) return { success: true };

  const res = await fetch(
    `${DV360_API}/advertisers/${advId}/creatives/${dspCreativeId}?updateMask=${updateMask.join(",")}`,
    { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(payload) }
  );
  const data = await res.json();
  if (data.creativeId) return { success: true };
  return { success: false, error: data.error?.message || JSON.stringify(data).substring(0, 500) };
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
    const { creativeId, changes } = body as { creativeId: string; changes: Record<string, unknown> };
    if (!creativeId || !changes || Object.keys(changes).length === 0) {
      return new Response(JSON.stringify({ error: "creativeId and changes required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { data: creative, error: fetchError } = await supabase.from("creatives").select("*").eq("id", creativeId).single();
    if (fetchError || !creative) return new Response(JSON.stringify({ error: "Creative not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    const editableFields = creative.dsp === "xandr" ? XANDR_EDITABLE : DV360_EDITABLE;
    const invalidFields = Object.keys(changes).filter(f => !editableFields.has(f));
    if (invalidFields.length > 0) {
      return new Response(JSON.stringify({ error: `Fields not editable for ${creative.dsp}: ${invalidFields.join(", ")}` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const dspConfig = typeof creative.dsp_config === "string" ? JSON.parse(creative.dsp_config) : (creative.dsp_config || {});
    const isHosted = !!creative.asset_filename;

    let syncResult: { success: boolean; error?: string };
    if (creative.dsp === "xandr") {
      syncResult = await updateXandrCreative(creative.dsp_creative_id, creative.creative_type, dspConfig, changes);
    } else if (creative.dsp === "dv360") {
      syncResult = await updateDV360Creative(creative.dsp_creative_id, creative.creative_type, isHosted, dspConfig, changes);
    } else {
      return new Response(JSON.stringify({ error: `DSP ${creative.dsp} not supported` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const editRows = Object.entries(changes).filter(([k]) => k !== "trackers").map(([fieldName, newValue]) => ({
      creative_id: creativeId, user_email: user.email!, user_name: user.user_metadata?.full_name || user.email,
      field_name: fieldName, old_value: creative[fieldName] != null ? String(creative[fieldName]) : null,
      new_value: newValue != null ? String(newValue) : null, synced_to_dsp: syncResult.success, sync_error: syncResult.error || null,
    }));
    if (changes.trackers !== undefined) {
      editRows.push({ creative_id: creativeId, user_email: user.email!, user_name: user.user_metadata?.full_name || user.email,
        field_name: "trackers", old_value: creative.trackers ? JSON.stringify(creative.trackers) : null,
        new_value: JSON.stringify(changes.trackers), synced_to_dsp: syncResult.success, sync_error: syncResult.error || null });
    }
    if (editRows.length > 0) await supabase.from("creative_edits").insert(editRows);

    const dbUpdate: Record<string, unknown> = {};
    if (changes.name !== undefined) dbUpdate.name = changes.name;
    if (changes.click_url !== undefined) dbUpdate.click_url = changes.click_url;
    if (changes.landing_page !== undefined) dbUpdate.landing_page = changes.landing_page;
    if (changes.vast_tag !== undefined) dbUpdate.vast_tag = changes.vast_tag;
    if (changes.trackers !== undefined) dbUpdate.trackers = JSON.stringify(changes.trackers);
    dbUpdate.last_edited_by_email = user.email;
    dbUpdate.last_edited_by_name = user.user_metadata?.full_name || user.email;
    if (syncResult.success) { dbUpdate.last_synced_at = new Date().toISOString(); dbUpdate.sync_error = null; }
    else { dbUpdate.sync_error = syncResult.error; }
    await supabase.from("creatives").update(dbUpdate).eq("id", creativeId);

    return new Response(JSON.stringify({ success: syncResult.success, creativeId, dsp: creative.dsp, isHosted, syncedToDsp: syncResult.success, syncError: syncResult.error || null, fieldsUpdated: Object.keys(changes) }), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
