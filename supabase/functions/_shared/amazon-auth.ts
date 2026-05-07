// Amazon DSP / Login with Amazon (LwA) authentication helpers.
//
// Architecture confirmed via empirical exploration (see commit history):
// - LwA refresh tokens are long-lived and stored in dsp_amazon_credentials.
// - Access tokens (TTL 60min) are cached in-memory + DB across isolates.
// - DSP API requires THREE identifiers per request:
//     1. Amazon-Advertising-API-ClientId   (LwA app client ID — public)
//     2. Amazon-Advertising-API-Scope      (agency profile_id, NOT vendor profile)
//     3. Amazon-Ads-AccountId              (DSP advertiser ID, e.g. 4968167560201)
// - Without all three, endpoints return 401/INVALID_HEADER_FIELD_PROFILE or
//   400/INVALID_ACCOUNT_ID. Discovered the hard way; documented here so we
//   never repeat it.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const AMAZON_ADS_API = "https://advertising-api.amazon.com";
export const AMAZON_LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const AMAZON_LWA_AUTH_URL = "https://www.amazon.com/ap/oa";
export const AMAZON_DSP_SCOPE = "advertising::campaign_management";

// HYPR is currently the sole advertiser. If multi-tenant arrives later,
// these become per-row lookups instead of constants.
export const AMAZON_HYPR_ADVERTISER_ID = "4968167560201";
export const AMAZON_HYPR_ADVERTISER_NAME = "HYPR";

// In-memory caches per-isolate. DB caches cover cold starts on other isolates.
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiry = 0;
let cachedProfileId: string | null = null;
let cachedAccountId: string | null = null;

interface AmazonCredentials {
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  profile_id: string | null;
  account_entity_id: string | null;
}

async function loadCredentials(supabase: SupabaseClient): Promise<AmazonCredentials> {
  const { data, error } = await supabase
    .from("dsp_amazon_credentials")
    .select("refresh_token, access_token, access_token_expires_at, profile_id, account_entity_id")
    .eq("advertiser_id", AMAZON_HYPR_ADVERTISER_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed to load Amazon credentials: ${error.message}`);
  if (!data) throw new Error("Amazon DSP not connected. Run OAuth flow first.");
  return data as AmazonCredentials;
}

/**
 * Get a valid Amazon Ads access token. Refreshes via LwA if expired.
 * Updates both in-memory cache and the DB row so other isolates benefit.
 */
export async function getAmazonAccessToken(supabase: SupabaseClient): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60_000) {
    return cachedAccessToken;
  }

  const creds = await loadCredentials(supabase);

  // DB-cached token still valid? Reuse.
  if (
    creds.access_token &&
    creds.access_token_expires_at &&
    new Date(creds.access_token_expires_at).getTime() > Date.now() + 60_000
  ) {
    cachedAccessToken = creds.access_token;
    cachedAccessTokenExpiry = new Date(creds.access_token_expires_at).getTime();
    return creds.access_token;
  }

  const clientId = Deno.env.get("AMAZON_DSP_CLIENT_ID");
  const clientSecret = Deno.env.get("AMAZON_DSP_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("AMAZON_DSP_CLIENT_ID or AMAZON_DSP_CLIENT_SECRET not configured");
  }

  const refreshRes = await fetch(AMAZON_LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const refreshData = await refreshRes.json();
  if (!refreshRes.ok || !refreshData.access_token) {
    throw new Error(
      `Amazon LwA token refresh failed (${refreshRes.status}): ${JSON.stringify(refreshData).substring(0, 300)}`
    );
  }

  const newToken = refreshData.access_token as string;
  const expiresIn = (refreshData.expires_in as number) || 3600;
  const expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000);

  await supabase
    .from("dsp_amazon_credentials")
    .update({
      access_token: newToken,
      access_token_expires_at: expiresAt.toISOString(),
    })
    .eq("advertiser_id", AMAZON_HYPR_ADVERTISER_ID);

  cachedAccessToken = newToken;
  cachedAccessTokenExpiry = expiresAt.getTime();
  return newToken;
}

/**
 * Resolve the agency profile_id (NOT vendor) — required as
 * Amazon-Advertising-API-Scope header on every DSP API call.
 */
export async function getAmazonProfileId(supabase: SupabaseClient): Promise<string> {
  if (cachedProfileId) return cachedProfileId;
  const creds = await loadCredentials(supabase);
  if (!creds.profile_id) {
    throw new Error("Amazon profile_id not set. Re-run OAuth flow to populate.");
  }
  cachedProfileId = creds.profile_id;
  return creds.profile_id;
}

/**
 * Resolve the DSP advertiser-as-account-id — required as
 * Amazon-Ads-AccountId header on creative/experience endpoints.
 */
export async function getAmazonAccountId(supabase: SupabaseClient): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const creds = await loadCredentials(supabase);
  if (!creds.account_entity_id) {
    throw new Error("Amazon account_entity_id not set. Re-run OAuth flow.");
  }
  cachedAccountId = creds.account_entity_id;
  return creds.account_entity_id;
}

/**
 * Build the full set of headers required for any Amazon DSP API call.
 * Includes Authorization + ClientId + Scope (profile) + AccountId (advertiser) + Content-Type.
 */
export async function getAmazonApiHeaders(supabase: SupabaseClient): Promise<Record<string, string>> {
  const [token, profileId, accountId] = await Promise.all([
    getAmazonAccessToken(supabase),
    getAmazonProfileId(supabase),
    getAmazonAccountId(supabase),
  ]);
  const clientId = Deno.env.get("AMAZON_DSP_CLIENT_ID");
  if (!clientId) throw new Error("AMAZON_DSP_CLIENT_ID not configured");

  return {
    "Authorization": `Bearer ${token}`,
    "Amazon-Advertising-API-ClientId": clientId,
    "Amazon-Advertising-API-Scope": profileId,
    "Amazon-Ads-AccountId": accountId,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

/**
 * Build the OAuth Authorization URL the user visits to grant access.
 * Returns the URL string; caller is responsible for redirecting the browser.
 */
export function buildAmazonAuthorizationUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const clientId = Deno.env.get("AMAZON_DSP_CLIENT_ID");
  if (!clientId) throw new Error("AMAZON_DSP_CLIENT_ID not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    scope: AMAZON_DSP_SCOPE,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${AMAZON_LWA_AUTH_URL}?${params.toString()}`;
}
