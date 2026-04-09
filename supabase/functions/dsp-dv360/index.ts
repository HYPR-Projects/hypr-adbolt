// dsp-dv360 Edge Function — Create third-party display creatives via DV360 API v4
// Supabase secrets: DV360_SERVICE_ACCOUNT_KEY (JSON), DV360_ADVERTISER_ID

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { create, getNumericDate } from "https://deno.land/x/djwt@v2.9.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Helpers ──

function base64UrlToArrayBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  return base64UrlToArrayBuffer(b64);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getAccessToken(saKey: any): Promise<string> {
  const scope = "https://www.googleapis.com/auth/display-video";
  const now = Math.floor(Date.now() / 1000);
  const key = await importPrivateKey(saKey.private_key);

  const jwt = await create(
    { alg: "RS256", typ: "JWT" },
    {
      iss: saKey.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: getNumericDate(0),
      exp: getNumericDate(3600),
    },
    key
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth token error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ── Parse dimensions ──
function parseDimensions(dim: string): { w: number; h: number } {
  const m = dim.match(/(\d+)\s*x\s*(\d+)/i);
  if (!m) return { w: 1, h: 1 };
  return { w: parseInt(m[1]), h: parseInt(m[2]) };
}

// ── Create a single third-party display creative ──
async function createCreative(
  token: string,
  advertiserId: string,
  creative: { name: string; dimensions: string; jsTag: string; clickUrl: string },
  trackingPixel?: string
): Promise<{ success: boolean; name: string; creativeId?: string; error?: string }> {
  const { w, h } = parseDimensions(creative.dimensions);

  const thirdPartyUrls: any[] = [];
  if (trackingPixel) {
    thirdPartyUrls.push({
      type: "THIRD_PARTY_URL_TYPE_IMPRESSION",
      url: trackingPixel,
    });
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
        type: "EXIT_EVENT_TYPE_DEFAULT",
        url: creative.clickUrl || "https://www.example.com",
      },
    ],
  };

  if (thirdPartyUrls.length) {
    body.thirdPartyUrls = thirdPartyUrls;
  }

  const url = `https://displayvideo.googleapis.com/v4/advertisers/${advertiserId}/creatives`;

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

  try {
    // Parse service account key
    const saKeyRaw = Deno.env.get("DV360_SERVICE_ACCOUNT_KEY");
    if (!saKeyRaw) throw new Error("DV360_SERVICE_ACCOUNT_KEY not configured");
    const saKey = JSON.parse(saKeyRaw);

    const advertiserId = Deno.env.get("DV360_ADVERTISER_ID");
    if (!advertiserId) throw new Error("DV360_ADVERTISER_ID not configured");

    // Parse request body
    const {
      creatives,
      trackingPixel,
      campaignName,
      advertiserName,
    } = await req.json();

    if (!creatives?.length) {
      return new Response(
        JSON.stringify({ error: "Nenhum criativo recebido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get OAuth2 access token
    const token = await getAccessToken(saKey);

    // Create creatives sequentially (DV360 rate limits are tight)
    const results: any[] = [];
    let successCount = 0;

    for (const c of creatives) {
      const result = await createCreative(token, advertiserId, c, trackingPixel);
      results.push(result);
      if (result.success) successCount++;

      // Small delay between requests to respect rate limits
      if (creatives.length > 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const status = successCount === creatives.length
      ? "success"
      : successCount > 0
      ? "partial"
      : "error";

    return new Response(
      JSON.stringify({
        status,
        total: creatives.length,
        success: successCount,
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
