import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64url } from "https://deno.land/std@0.208.0/encoding/base64url.ts";

const XANDR_API = "https://api.appnexus.com";
const MEMBER_ID = 14843;
const DV360_API = "https://displayvideo.googleapis.com/v4";
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
  if (!td.access_token) throw new Error(`Google OAuth failed`);
  cachedDV360Token = td.access_token; dv360TokenExpiry = Date.now() + (td.expires_in - 60) * 1000;
  return cachedDV360Token!;
}

async function deleteXandr(token: string, id: string, type: string, advId: number): Promise<{success:boolean;error?:string}> {
  try {
    const ep = type==='video'?`${XANDR_API}/creative-vast?id=${id}&member_id=${MEMBER_ID}&advertiser_id=${advId}`:`${XANDR_API}/creative?id=${id}&member_id=${MEMBER_ID}&advertiser_id=${advId}`;
    const r = await fetch(ep, { method: 'DELETE', headers: { Authorization: token } });
    const d = await r.json();
    return d.response?.status === 'OK' ? { success: true } : { success: false, error: d.response?.error_message || 'Delete failed' };
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
}

async function archiveDV360(token: string, id: string, advId: string): Promise<{success:boolean;error?:string}> {
  try {
    const r = await fetch(`${DV360_API}/advertisers/${advId}/creatives/${id}?updateMask=entityStatus`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ entityStatus: 'ENTITY_STATUS_ARCHIVED' }) });
    const d = await r.json();
    if (d.creativeId) return { success: true };
    if (d.error?.message?.includes('CONCURRENCY')) {
      await new Promise(w => setTimeout(w, 1000));
      const r2 = await fetch(`${DV360_API}/advertisers/${advId}/creatives/${id}?updateMask=entityStatus`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ entityStatus: 'ENTITY_STATUS_ARCHIVED' }) });
      const d2 = await r2.json();
      if (d2.creativeId) return { success: true };
      return { success: false, error: d2.error?.message || 'Archive failed after retry' };
    }
    return { success: false, error: d.error?.message || 'Archive failed' };
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json();
    const { creativeIds } = body as { creativeIds: string[] };
    if (!creativeIds?.length) return new Response(JSON.stringify({ error: 'creativeIds required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    const { data: creatives, error: qe } = await sb.from('creatives').select('*').in('id', creativeIds);
    if (qe || !creatives?.length) return new Response(JSON.stringify({ error: 'Creatives not found' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    let deleted = 0, archived = 0, failed = 0;
    const errors: Array<{ id: string; error: string }> = [];
    const now = () => new Date().toISOString();

    const xandrList = creatives.filter(c => c.dsp === 'xandr');
    const dv360List = creatives.filter(c => c.dsp === 'dv360');

    await Promise.all([
      (async () => {
        if (!xandrList.length) return;
        const token = await getXandrToken();
        await Promise.all(xandrList.map(async c => {
          const cfg = typeof c.dsp_config === 'string' ? JSON.parse(c.dsp_config) : (c.dsp_config || {});
          const result = await deleteXandr(token, c.dsp_creative_id, c.creative_type, cfg.advertiser_id || 7392214);
          if (result.success) {
            await sb.from('creatives').update({ status: 'deleted', audit_status: 'deleted', sync_error: null, last_synced_at: now() }).eq('id', c.id);
            deleted++;
          } else { errors.push({ id: c.id, error: result.error || 'Unknown' }); failed++; }
        }));
      })(),
      (async () => {
        if (!dv360List.length) return;
        const token = await getDV360Token();
        for (let i = 0; i < dv360List.length; i += 5) {
          const batch = dv360List.slice(i, i + 5);
          await Promise.all(batch.map(async c => {
            const cfg = typeof c.dsp_config === 'string' ? JSON.parse(c.dsp_config) : (c.dsp_config || {});
            const advId = String(cfg.advertiser_id || Deno.env.get('DV360_ADVERTISER_ID') || '1426474713');
            const result = await archiveDV360(token, c.dsp_creative_id, advId);
            if (result.success) {
              await sb.from('creatives').update({ status: 'deleted', audit_status: 'archived', sync_error: null, last_synced_at: now() }).eq('id', c.id);
              archived++;
            } else { errors.push({ id: c.id, error: result.error || 'Unknown' }); failed++; }
          }));
        }
      })()
    ]);

    return new Response(JSON.stringify({ deleted, archived, failed, total: creatives.length, errors: errors.length ? errors : undefined }), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
});
