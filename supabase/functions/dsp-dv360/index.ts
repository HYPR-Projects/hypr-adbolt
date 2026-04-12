// dsp-dv360 Edge Function — Create third-party display creatives via DV360 API v4
// Supabase secrets: DV360_SERVICE_ACCOUNT_KEY (JSON), DV360_ADVERTISER_ID

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getDV360Token, DV360_API } from "../_shared/dv360-auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Parse dimensions ──
function parseDimensions(dim: string): { w: number; h: number } {
  const m = dim.match(/(\d+)\s*x\s*(\d+)/i);
  if (!m) return { w: 1, h: 1 };
  return { w: parseInt(m[1]), h: parseInt(m[2]) };
}


// Extract ClickThrough URL from VAST — supports both inline XML and pre-fetch URLs
async function extractClickThroughFromVast(vastInput: string): Promise<string | null> {
  let xml = vastInput;

  // If it's a URL (not inline XML), fetch the VAST XML
  if (vastInput.startsWith("http")) {
    try {
      // Resolve common macros so the ad server returns valid XML
      let url = vastInput
        .replace(/\[timestamp\]/gi, String(Date.now()))
        .replace(/\[cachebuster\]/gi, String(Math.floor(Math.random() * 1e9)))
        .replace(/\$\{GDPR\}/g, "0")
        .replace(/\$\{GDPR_CONSENT_\d+\}/g, "")
        .replace(/\$\(GDPR\)/g, "0")
        .replace(/\$\(GDPR_CONSENT_\d+\)/g, "")
        .replace(/ord=[^;]*/g, "ord=" + Date.now());
      
      const res = await fetch(url, {
        headers: { "Accept": "application/xml, text/xml, */*" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.log(`[dv360] VAST fetch failed: ${res.status} for ${url.substring(0, 100)}`);
        return null;
      }
      xml = await res.text();
    } catch (e) {
      console.log(`[dv360] VAST fetch error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // Parse ClickThrough from XML (handles CDATA and plain text)
  const ctMatch = xml.match(/<ClickThrough[^>]*>\s*<!\[CDATA\[([^\]]+)\]\]>/i)
    || xml.match(/<ClickThrough[^>]*>([^<]+)</i);
  if (ctMatch) {
    const url = ctMatch[1].trim();
    // Validate it looks like a real URL
    if (url.startsWith("http")) return url;
  }
  return null;
}

// ── Create a single third-party display creative ──
async function createCreative(
  token: string,
  advertiserId: string,
  creative: { name: string; dimensions: string; jsTag: string; clickUrl: string; type?: string; vastTag?: string; trackers?: Array<{ url: string; format: string }> },
  trackingPixel?: string
): Promise<{ success: boolean; name: string; creativeId?: string; error?: string }> {
  const { w, h } = parseDimensions(creative.dimensions);

  // Build thirdPartyUrls from per-creative trackers + legacy global trackingPixel
  // DV360 API v4: thirdPartyUrls accepts [{type, url}] objects
  // trackerUrls expects plain string[] — NOT for 3P impression pixels
  // Route ALL trackers to thirdPartyUrls regardless of format
  const thirdPartyUrls: any[] = [];
  const seen = new Set<string>();

  if (trackingPixel && !seen.has(trackingPixel)) {
    seen.add(trackingPixel);
    thirdPartyUrls.push({ type: "THIRD_PARTY_URL_TYPE_IMPRESSION", url: trackingPixel });
  }

  for (const t of (creative.trackers || [])) {
    if (!t.url || seen.has(t.url)) continue;
    seen.add(t.url);
    thirdPartyUrls.push({ type: "THIRD_PARTY_URL_TYPE_IMPRESSION", url: t.url });
  }

  const body: any = {
    displayName: creative.name,
    entityStatus: "ENTITY_STATUS_ACTIVE",
    hostingSource: "HOSTING_SOURCE_THIRD_PARTY",
    creativeType: "CREATIVE_TYPE_STANDARD",
    dimensions: {
      widthPixels: w,
      heightPixels: h,
    },
    thirdPartyTag: creative.jsTag,
    exitEvents: [
      {
        name: "Landing Page",
        type: "EXIT_EVENT_TYPE_DEFAULT",
        url: creative.clickUrl || (creative.type === "video" && creative.vastTag ? (await extractClickThroughFromVast(creative.vastTag) || "https://www.example.com") : "https://www.example.com"),
      },
    ],
  };

  if (thirdPartyUrls.length) {
    body.thirdPartyUrls = thirdPartyUrls;
  }

  const url = `${DV360_API}/advertisers/${advertiserId}/creatives`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const errMsg = data?.error?.message || JSON.stringify(data);
    return { success: false, name: creative.name, error: `${res.status}: ${errMsg}` };
  }

  return {
    success: true,
    name: creative.name,
    creativeId: data.creativeId,
  };
}

// ── Main handler ──
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Auth: validate user JWT
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Auth token missing" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "User not authenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse service account key

    const advertiserId = Deno.env.get("DV360_ADVERTISER_ID");
    if (!advertiserId) throw new Error("DV360_ADVERTISER_ID not configured");

    // Parse request body
    const {
      creatives,
      trackingPixel,
      campaignName = "",
      advertiserName = "",
      brandName = "",
      sourceType = "tags",
    } = await req.json();

    if (!creatives?.length) {
      return new Response(
        JSON.stringify({ error: "Nenhum criativo recebido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create batch record
    const { data: batchData, error: batchError } = await supabase.from("creative_batches").insert({
      user_email: user.email,
      user_name: user.user_metadata?.full_name || user.email,
      source_type: sourceType === "surveys" ? "surveys" : "tags",
      campaign_name: campaignName || null,
      advertiser_name: advertiserName || null,
      brand_name: brandName || null,
      total_creatives: 0,
      dsps_activated: ["dv360"],
    }).select("id").single();
    const batchId = batchData?.id || null;
    if (batchError) console.error("Failed to create batch:", batchError.message);

    // Get OAuth2 access token
    const t0 = Date.now();
    const token = await getDV360Token();

    // Process in parallel batches of 5 (DV360 allows ~10 req/s per advertiser)
    const BATCH_SIZE = 5;
    const BATCH_DELAY = 250;
    const results: any[] = [];
    let successCount = 0;

    for (let i = 0; i < creatives.length; i += BATCH_SIZE) {
      const batch = creatives.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((c: any) => createCreative(token, advertiserId, c, trackingPixel))
      );
      for (const r of batchResults) {
        results.push(r);
        if (r.success) successCount++;
      }
      // Delay between batches to respect rate limits
      if (i + BATCH_SIZE < creatives.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY));
      }
    }

    // Insert successful creatives into DB
    const successResults = results.filter((r: any) => r.success);
    if (successResults.length > 0 && batchId) {
      const creativeRows = successResults.map((r: any, idx: number) => {
        const c = creatives[results.indexOf(r)] || creatives[idx] || {};
        const [w, h] = (c.dimensions || "0x0").split("x").map(Number);
        const allTrackers: Array<{url: string; format: string}> = [];
        if (trackingPixel) allTrackers.push({ url: trackingPixel, format: "url-image" });
        if (c.trackers) c.trackers.forEach((t: any) => {
          const url = typeof t === "string" ? t : t.url;
          const format = typeof t === "string" ? "url-image" : (t.format || "url-image");
          if (url) allTrackers.push({ url, format });
        });
        return {
          batch_id: batchId,
          created_by_email: user.email!,
          created_by_name: user.user_metadata?.full_name || user.email,
          dsp: "dv360" as const,
          dsp_creative_id: String(r.creativeId),
          name: r.name,
          creative_type: (c.type === "video" ? "video" : "display") as "display" | "video",
          dimensions: c.dimensions || `${w}x${h}`,
          js_tag: c.type === "video" ? null : (c.jsTag || null),
          vast_tag: c.type === "video" ? (c.vastTag || c.jsTag || null) : null,
          click_url: c.clickUrl || null,
          landing_page: c.clickUrl || null,
          trackers: JSON.stringify(allTrackers),
          dsp_config: JSON.stringify({ advertiser_id: advertiserId }),
          status: "active",
          audit_status: "pending",
          last_synced_at: new Date().toISOString(),
        };
      });
      const { error: insertError } = await supabase.from("creatives").insert(creativeRows);
      if (insertError) console.error("Failed to insert creatives:", insertError.message);
      await supabase.from("creative_batches").update({ total_creatives: successResults.length }).eq("id", batchId);
    }

    const status = successCount === creatives.length
      ? "success"
      : successCount > 0
      ? "partial"
      : "error";

    // Log activation
    await supabase.from("activation_log").insert({
      user_email: user.email,
      user_name: user.user_metadata?.full_name || user.email,
      dsp: "dv360",
      campaign_name: campaignName,
      advertiser_name: advertiserName,
      creatives_count: creatives.length,
      status,
      step: "complete", duration_ms: Date.now() - t0, edge_function: "dsp-dv360",
      request_payload: { advertiserId, creativesCount: creatives.length, batchId },
      response_summary: {
        total: results.length,
        success: successCount,
        failed: results.length - successCount,
        batchId,
        creativeIds: results.filter((r: any) => r.success).map((r: any) => r.creativeId),
      },
      error_message: status === "error" ? results[0]?.error : null,
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
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("dsp-dv360 error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
