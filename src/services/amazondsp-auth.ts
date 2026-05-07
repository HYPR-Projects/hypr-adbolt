import { SUPABASE_FUNCTIONS_URL, supabase } from '@/services/supabase';

/**
 * Amazon DSP OAuth + status helpers.
 * Wraps the `dsp-amazon-status` and `auth-amazon-callback` edge functions.
 *
 * Connection state lives in `dsp_amazon_credentials` (RLS-locked, read only
 * via service_role). Frontend never touches the table directly — all
 * state passes through these endpoints.
 */

// ── OAuth client config (mirrors what the backend uses) ──
// Client ID is public by design (it shows up in the auth URL the browser
// navigates to). Only the secret is kept on the server.
export const AMAZON_DSP_CLIENT_ID =
  'amzn1.application-oa2-client.d62291b6f2744ae3a2d559fb9814b57d';
export const AMAZON_DSP_SCOPE = 'advertising::campaign_management';
export const AMAZON_DSP_REDIRECT_URI =
  `${window.location.origin}/auth/amazon/callback`;
export const AMAZON_DSP_AUTH_URL = 'https://www.amazon.com/ap/oa';

export interface AmazonDspStatus {
  connected: boolean;
  advertiser_id: string;
  advertiser_name?: string;
  profile_id?: string;
  country_code?: string | null;
  currency_code?: string | null;
  scope?: string;
  authorized_by?: string;
  authorized_at?: string;
  access_token_expires_at?: string;
  updated_at?: string;
  message?: string;
}

export interface AmazonDspCallbackResult {
  status: 'success';
  advertiser_id: string;
  advertiser_name: string;
  profile_id: string;
  country_code: string | null;
  currency_code: string | null;
  profiles_available: number;
  authorized_by: string;
  authorized_at: string;
}

/**
 * Build the Amazon LwA authorization URL the user navigates to.
 * `state` is a CSRF token — we round-trip it through Amazon and verify on
 * return. Stored in sessionStorage so it survives the redirect.
 */
export function buildAmazonAuthUrl(): string {
  const state = crypto.randomUUID();
  sessionStorage.setItem('amazon_oauth_state', state);

  const params = new URLSearchParams({
    client_id: AMAZON_DSP_CLIENT_ID,
    scope: AMAZON_DSP_SCOPE,
    response_type: 'code',
    redirect_uri: AMAZON_DSP_REDIRECT_URI,
    state,
  });

  return `${AMAZON_DSP_AUTH_URL}?${params.toString()}`;
}

/**
 * Verify a returned `state` matches what we stored before redirecting.
 * Clears the stored state regardless to prevent replay.
 */
export function verifyAmazonAuthState(returnedState: string | null): boolean {
  const stored = sessionStorage.getItem('amazon_oauth_state');
  sessionStorage.removeItem('amazon_oauth_state');
  return !!stored && stored === returnedState;
}

/**
 * Fetch current Amazon DSP connection status.
 * Returns `connected: false` if no credentials exist yet (not an error).
 */
export async function fetchAmazonDspStatus(): Promise<AmazonDspStatus> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');

  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/dsp-amazon-status`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Status query failed (${res.status})`);
  }
  return data as AmazonDspStatus;
}

/**
 * Exchange the OAuth `code` for tokens and persist credentials.
 * Called from the AmazonCallback page after the redirect lands.
 */
export async function completeAmazonOAuth(code: string): Promise<AmazonDspCallbackResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');

  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/auth-amazon-callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      code,
      redirect_uri: AMAZON_DSP_REDIRECT_URI,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `OAuth callback failed (${res.status})`);
  }
  return data as AmazonDspCallbackResult;
}
