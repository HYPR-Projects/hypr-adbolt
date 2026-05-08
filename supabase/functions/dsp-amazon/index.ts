// dsp-amazon Edge Function — Create third-party display creatives via Amazon DSP API.
//
// Endpoint:  POST /dsp/v1/adCreatives
// Schema (per Amazon launch announcement, May 30 2024):
//   {
//     name, language, country, hostedType: "THIRD_PARTY_HOSTED",
//     adCreativeFormatProperties: {
//       adCreativeFormatType: "THIRD_PARTY",
//       adExperience: "THIRD_PARTY_DISPLAY",  ← REQUIRED for new Creative Manager visibility
//       creativeSizes: [{ width, height, responsive: false }],
//       thirdPartyTag: { tagSource, tagType: "DISPLAY", destinationOnAmazon: "OFF_AMAZON" }
//     }
//   }
//
// Without `adExperience`, the API still returns 2xx with an `adCreativeId` but
// the creative falls into the legacy "Third Party" / "Third Party - mobile AAP"
// templates that don't surface in the modern Creatives UI. Adding the field
// pins the creative to the consolidated 3P display experience that supports
// 54 placement sizes and is browseable in the Creative Manager.
//
// Headers (ALL three required, found via probing):
//   Authorization: Bearer <access_token>
//   Amazon-Advertising-API-ClientId: <client_id>
//   Amazon-Advertising-API-Scope: <agency profile_id>
//   Amazon-Ads-AccountId: <DSP advertiser_id>     ← misleading name, wants advertiserId
//
// Scope: Phase 3 covers display 3P tags (Embeds & AdServer Tags + Surveys).
// Video VAST 3P and Asset uploads are deferred (Phase 4).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AMAZON_ADS_API,
  AMAZON_HYPR_ADVERTISER_ID,
  getAmazonApiHeaders,
} from "../_shared/amazon-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface CreativeInput {
  name: string;
  dimensions: string;
  jsTag: string;
  clickUrl?: string;
  type?: string;
  vastTag?: string;
  trackers?: Array<{ url: string; format: string }>;
}

interface CreativeResult {
  success: boolean;
  name: string;
  creativeId?: string;
  error?: string;
  // Per-call diagnostic captured for every Amazon API attempt. Persisted in
  // activation_log.response_summary so silent successes (2xx + adCreativeId
  // but no creative visible in the UI) leave forensic traces.
  diagnostic?: { httpStatus: number; bodyPreview: string };
}

function parseDimensions(dim: string): { w: number; h: number } {
  const m = dim.match(/(\d+)\s*x\s*(\d+)/i);
  if (!m) return { w: 1, h: 1 };
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

/**
 * Create a single 3P display creative on Amazon DSP.
 * Video VAST 3P is intentionally out of scope for Phase 3 — those creatives
 * are flagged and reported as "not supported yet".
 */
async function createCreative(
  headers: Record<string, string>,
  creative: CreativeInput,
): Promise<CreativeResult> {
  // Phase 3 explicitly excludes video. Surface a clear message instead of failing silently.
  if (creative.type === "video") {
    return {
      success: false,
      name: creative.name,
      error: "Amazon DSP video VAST 3P not yet supported (Phase 4)",
    };
  }

  const { w, h } = parseDimensions(creative.dimensions);
  if (!creative.jsTag || creative.jsTag.trim().length === 0) {
    return { success: false, name: creative.name, error: "Empty 3P tag source" };
  }

  const body = {
    name: creative.name,
    language: "pt",
    country: "BR",
    hostedType: "THIRD_PARTY_HOSTED",
    adCreativeFormatProperties: {
      adCreativeFormatType: "THIRD_PARTY",
      adExperience: "THIRD_PARTY_DISPLAY",
      creativeSizes: [{ width: w, height: h, responsive: false }],
      thirdPartyTag: {
        tagSource: creative.jsTag,
        tagType: "DISPLAY",
        destinationOnAmazon: "OFF_AMAZON",
      },
    },
  };

  // Modest retry on 429 — Amazon rate-limits aggressive parallel writes.
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 2000;
      console.log(`[amazon] Retry ${attempt}/${MAX_RETRIES} for ${creative.name} after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    let res: Response;
    try {
      res = await fetch(`${AMAZON_ADS_API}/dsp/v1/adCreatives`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return {
        success: false,
        name: creative.name,
        error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const text = await res.text();
    const bodyPreview = text.substring(0, 600);
    console.log(`[amazon] ${creative.name} → HTTP ${res.status}: ${bodyPreview.substring(0, 300)}`);

    let parsed: { adCreativeId?: string; errors?: Array<{ errorCode?: string; errorMessage?: string }>; message?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* keep empty, fall through */ }

    const diagnostic = { httpStatus: res.status, bodyPreview };

    if (res.ok && parsed.adCreativeId) {
      return { success: true, name: creative.name, creativeId: String(parsed.adCreativeId), diagnostic };
    }

    // 429 → retry
    if (res.status === 429 && attempt < MAX_RETRIES) continue;

    // Anything else → bail with the API's error message
    const errMsg = parsed.errors?.[0]
      ? `${parsed.errors[0].errorCode}: ${parsed.errors[0].errorMessage}`
      : parsed.message || `HTTP ${res.status}: ${text.substring(0, 200)}`;
    return { success: false, name: creative.name, error: errMsg, diagnostic };
  }

  return { success: false, name: creative.name, error: "Max retries exceeded" };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Auth token missing" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user } } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (!user) {
      return new Response(JSON.stringify({ error: "User not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await req.json();
    const {
      creatives = [],
      trackingPixel: _trackingPixel, // accepted for API parity, currently no-op on Amazon
      campaignName,
      advertiserName,
      brandName,
      sourceType,
      activationSessionId,
    } = payload;

    if (!Array.isArray(creatives) || creatives.length === 0) {
      return new Response(JSON.stringify({ error: "No creatives provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const t0 = Date.now();

    // Create batch row
    const { data: batchData, error: batchError } = await supabase
      .from("creative_batches")
      .insert({
        user_email: user.email!,
        user_name: user.user_metadata?.full_name || user.email,
        source_type: sourceType === "surveys" ? "surveys" : "tags",
        campaign_name: campaignName || null,
        advertiser_name: advertiserName || null,
        brand_name: brandName || null,
        total_creatives: 0,
        dsps_activated: ["amazondsp"],
      })
      .select("id")
      .single();
    const batchId = batchData?.id || null;
    if (batchError) console.error("Failed to create batch:", batchError.message);

    // Build auth headers once (cached internally for the isolate lifetime)
    let headers: Record<string, string>;
    try {
      headers = await getAmazonApiHeaders(supabase);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("activation_log").insert({
        user_email: user.email,
        user_name: user.user_metadata?.full_name || user.email,
        dsp: "amazondsp",
        campaign_name: campaignName,
        advertiser_name: advertiserName,
        creatives_count: creatives.length,
        status: "error",
        step: "auth",
        duration_ms: Date.now() - t0,
        edge_function: "dsp-amazon",
        error_message: msg,
      });
      return new Response(
        JSON.stringify({ status: "error", error: `Amazon auth failed: ${msg}`, batchId }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Process in batches of 3 to avoid 429s under load
    const BATCH_SIZE = 3;
    const BATCH_DELAY = 700;
    const results: CreativeResult[] = [];
    let successCount = 0;

    for (let i = 0; i < creatives.length; i += BATCH_SIZE) {
      const batch = creatives.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((c: CreativeInput) => createCreative(headers, c)),
      );
      for (const r of batchResults) {
        results.push(r);
        if (r.success) successCount++;
      }
      if (i + BATCH_SIZE < creatives.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY));
      }
    }

    // Persist successful creatives
    const successResults = results.filter((r) => r.success);
    if (successResults.length > 0 && batchId) {
      const creativeRows = successResults.map((r) => {
        const idx = results.indexOf(r);
        const c: CreativeInput = creatives[idx] || ({} as CreativeInput);
        const [w, h] = (c.dimensions || "0x0").split("x").map(Number);
        const allTrackers: Array<{ url: string; format: string }> = [];
        if (c.trackers) {
          for (const t of c.trackers) {
            const url = typeof t === "string" ? t : t.url;
            const format = typeof t === "string" ? "url-image" : (t.format || "url-image");
            if (url) allTrackers.push({ url, format });
          }
        }
        return {
          batch_id: batchId,
          activation_session_id: activationSessionId || null,
          created_by_email: user.email!,
          created_by_name: user.user_metadata?.full_name || user.email,
          dsp: "amazondsp" as const,
          dsp_creative_id: String(r.creativeId),
          name: r.name,
          creative_type: "display" as const,
          dimensions: c.dimensions || `${w}x${h}`,
          js_tag: c.jsTag || null,
          vast_tag: null,
          click_url: c.clickUrl || null,
          landing_page: c.clickUrl || null,
          trackers: JSON.stringify(allTrackers),
          dsp_config: JSON.stringify({ advertiser_id: AMAZON_HYPR_ADVERTISER_ID }),
          status: "active",
          audit_status: "pending",
          last_synced_at: new Date().toISOString(),
        };
      });
      const { error: insertError } = await supabase.from("creatives").insert(creativeRows);
      if (insertError) console.error("Failed to insert creatives:", insertError.message);
      await supabase
        .from("creative_batches")
        .update({ total_creatives: successResults.length })
        .eq("id", batchId);
    }

    const status =
      successCount === creatives.length
        ? "success"
        : successCount > 0
        ? "partial"
        : "error";

    await supabase.from("activation_log").insert({
      user_email: user.email,
      user_name: user.user_metadata?.full_name || user.email,
      dsp: "amazondsp",
      campaign_name: campaignName,
      advertiser_name: advertiserName,
      creatives_count: creatives.length,
      status,
      step: "complete",
      duration_ms: Date.now() - t0,
      edge_function: "dsp-amazon",
      request_payload: {
        advertiserId: AMAZON_HYPR_ADVERTISER_ID,
        creativesCount: creatives.length,
        batchId,
        // Verifies which DSP-side identifiers the request actually carried.
        // If the wrong account/profile is being injected, this is where we'll see it.
        sentAccountId: headers["Amazon-Ads-AccountId"],
        sentProfileId: headers["Amazon-Advertising-API-Scope"],
      },
      response_summary: {
        total: results.length,
        success: successCount,
        failed: results.length - successCount,
        batchId,
        creativeIds: results.filter((r) => r.success).map((r) => r.creativeId),
        // Forensic trail: HTTP status + first 600 chars of Amazon's response
        // for every creative attempt. Lets us debug silent successes after
        // the fact instead of needing to repro live.
        diagnostics: results.map((r) => ({
          name: r.name,
          success: r.success,
          httpStatus: r.diagnostic?.httpStatus,
          bodyPreview: r.diagnostic?.bodyPreview,
        })),
      },
      error_message: status === "error" ? results[0]?.error || null : null,
    });

    return new Response(
      JSON.stringify({
        status,
        total: creatives.length,
        success: successCount,
        failed: results.length - successCount,
        batchId,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dsp-amazon error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
