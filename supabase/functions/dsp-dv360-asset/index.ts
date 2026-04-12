import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64url } from "https://deno.land/std@0.208.0/encoding/base64url.ts";

const DV360_API = "https://displayvideo.googleapis.com/v4";
const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, content-type, x-client-info, apikey","Access-Control-Allow-Methods":"POST, OPTIONS"};

let cachedToken: string|null = null, tokenExp = 0;

async function importKey(pem: string): Promise<CryptoKey> {
  const b = pem.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\n/g,'').replace(/
/g,'').replace(/\s/g,'');
  return crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(b),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExp) return cachedToken;
  const raw = Deno.env.get('DV360_SERVICE_ACCOUNT_KEY');
  if (!raw) throw new Error('DV360_SERVICE_ACCOUNT_KEY not set');
  const sa = JSON.parse(raw), now = Math.floor(Date.now()/1000), enc = new TextEncoder();
  const h = base64url(enc.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const p = base64url(enc.encode(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/display-video',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const si = `${h}.${p}`, key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(si));
  const jwt = `${si}.${base64url(new Uint8Array(sig))}`;
  const r = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`});
  const d = await r.json();
  if (!d.access_token) throw new Error('Google OAuth failed');
  cachedToken = d.access_token; tokenExp = Date.now()+(d.expires_in-60)*1000;
  return cachedToken!;
}

function normalizeTrackerInput(t: unknown): {url: string; format: string} {
  if (typeof t === 'string') return {url: t, format: 'url-image'};
  const obj = t as {url?: string; format?: string};
  return {url: obj.url || '', format: obj.format || 'url-image'};
}

interface Input { name:string; type:'display'|'video'|'html5'; dimensions:string; fileName:string; mimeType:string; storagePath?:string; fileBase64?:string; fileSize?:number; landingPage:string; trackers?:unknown[]; duration?:number; thumbnailUrl?:string; html5PreviewUrl?:string; }
interface Result { name:string; success:boolean; creativeId?:string; error?:string; step?:string; _input?:Input; }

async function getFileBytes(sb: any, input: Input): Promise<Uint8Array> {
  if (input.storagePath) {
    const { data, error } = await sb.storage.from('asset-uploads').download(input.storagePath);
    if (error || !data) throw new Error(`Storage download: ${error?.message || 'no data'}`);
    return new Uint8Array(await data.arrayBuffer());
  }
  if (input.fileBase64) { const b = atob(input.fileBase64); const arr = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i); return arr; }
  throw new Error('No file data');
}

async function process(token: string, advId: string, input: Input, sb: any): Promise<Result> {
  try {
    const bytes = await getFileBytes(sb, input);
    const isVideo = input.type === 'video';
    const [w,h] = input.dimensions.split('x').map(Number);
    const normalizedTrackers = (input.trackers||[]).map(t => normalizeTrackerInput(t)).filter(n => n.url);
    // Normalize landingPage URL
    const lp = input.landingPage ? (!/^https?:\/\//i.test(input.landingPage.trim()) ? 'https://' + input.landingPage.trim() : input.landingPage.trim()) : '';
    // Collect tracker URLs for appendedTag
    const allTrackerUrls: Array<{type: string; url: string}> = [];
    const seen = new Set<string>();
    for (const t of normalizedTrackers) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      allTrackerUrls.push({type: 'THIRD_PARTY_URL_TYPE_IMPRESSION', url: t.url});
    }
    console.log(`[dv360-asset] Uploading ${input.fileName} (${bytes.length} bytes, ${input.mimeType}), type=${input.type}`);
    if (isVideo && bytes.length < 1000) { return {name:input.name, success:false, error:`File too small (${bytes.length} bytes)`, step:'validate'}; }

    const boundary = '----DV360' + Date.now() + Math.random().toString(36).substr(2,8);
    const CRLF = '
';
    const enc = new TextEncoder();
    const metaJson = JSON.stringify({filename: input.fileName});
    const metaPart = enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="data"${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metaJson}${CRLF}`);
    const fileHeader = enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${input.fileName}"${CRLF}Content-Type: ${input.mimeType}${CRLF}${CRLF}`);
    const fileFooter = enc.encode(CRLF);
    const closing = enc.encode(`--${boundary}--${CRLF}`);
    const totalLen = metaPart.length + fileHeader.length + bytes.length + fileFooter.length + closing.length;
    const body = new Uint8Array(totalLen);
    let offset = 0;
    body.set(metaPart, offset); offset += metaPart.length;
    body.set(fileHeader, offset); offset += fileHeader.length;
    body.set(bytes, offset); offset += bytes.length;
    body.set(fileFooter, offset); offset += fileFooter.length;
    body.set(closing, offset);

    const uploadRes = await fetch(`https://displayvideo.googleapis.com/upload/v4/advertisers/${advId}/assets?uploadType=multipart`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
    const uploadText = await uploadRes.text();
    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch { return {name:input.name, success:false, error:`Upload parse: ${uploadText.substring(0,200)}`, step:'upload'}; }
    const mediaId = uploadData.asset?.mediaId;
    if (!mediaId) return {name:input.name, success:false, error:`No mediaId: ${uploadData.error?.message || uploadText.substring(0,200)}`, step:'upload'};

    const creative: Record<string,unknown> = {
      displayName: input.name, entityStatus: 'ENTITY_STATUS_ACTIVE', hostingSource: 'HOSTING_SOURCE_HOSTED',
      creativeType: isVideo ? 'CREATIVE_TYPE_VIDEO' : 'CREATIVE_TYPE_STANDARD',
      assets: [{asset:{mediaId}, role:'ASSET_ROLE_MAIN'}],
      exitEvents: [{name:'Landing Page', type:'EXIT_EVENT_TYPE_DEFAULT', url:lp||'https://example.com'}]
    };
    if (!isVideo) creative.dimensions = {widthPixels:w||1, heightPixels:h||1};
    // Hosted creatives: display uses appendedTag, video uses thirdPartyUrls
    if (allTrackerUrls.length) {
      if (isVideo) {
        // Video creatives use thirdPartyUrls array
        creative.thirdPartyUrls = allTrackerUrls.map(t => ({ type: t.type, url: t.url }));
      } else {
        // Display/HTML5 use appendedTag (maps to "Append HTML tracking tag" in DV360 UI)
        const tagParts = allTrackerUrls.map(t => {
          const lower = t.url.toLowerCase();
          if (lower.endsWith('.js') || lower.includes('.js?') || lower.includes('/js/')) {
            return `<scr` + `ipt src="${t.url}"></scr` + `ipt>`;
          }
          return `<img src="${t.url}" width="1" height="1" style="display:none" />`;
        });
        creative.appendedTag = tagParts.join('
');
      }
    }

    const createBody = JSON.stringify(creative);
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) { const delay = attempt * 5000; console.log(`[dv360-asset] Retry ${attempt}/${MAX_RETRIES} after ${delay}ms...`); await new Promise(r => setTimeout(r, delay)); }
      const createRes = await fetch(`${DV360_API}/advertisers/${advId}/creatives`,{ method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:createBody });
      const createText = await createRes.text();
      let createData;
      try { createData = JSON.parse(createText); } catch { return {name:input.name, success:false, error:`Create parse: ${createText.substring(0,200)}`, step:'create'}; }
      if (createData.creativeId) return {name:input.name, success:true, creativeId:createData.creativeId, _input:input};
      const errMsg = createData.error?.message || createText;
      if (errMsg.includes('CONCURRENCY') && attempt < MAX_RETRIES) continue;
      return {name:input.name, success:false, error:`Create: ${errMsg.substring(0,300)}`, step:'create'};
    }
    return {name:input.name, success:false, error:'Max retries exceeded', step:'create'};
  } catch(err) {
    return {name:input.name, success:false, error:err instanceof Error?err.message:String(err), step:'exception'};
  }
}

Deno.serve(async(req)=>{
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:CORS});
  if (req.method!=='POST') return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers:{...CORS,'Content-Type':'application/json'}});
  try {
    const ah = req.headers.get('authorization');
    if (!ah?.startsWith('Bearer ')) return new Response(JSON.stringify({error:'Auth missing'}),{status:401,headers:{...CORS,'Content-Type':'application/json'}});
    const sb = createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const {data:{user},error:ae} = await sb.auth.getUser(ah.replace('Bearer ',''));
    if (ae||!user) return new Response(JSON.stringify({error:'Auth failed'}),{status:401,headers:{...CORS,'Content-Type':'application/json'}});
    const body = await req.json();
    const advId = body.advertiserId||Deno.env.get('DV360_ADVERTISER_ID')||'1426474713';
    const {campaignName='',advertiserName='',brandName='',creatives=[]} = body;
    const normLp = (u: string|null|undefined) => { if (!u) return null; const t = u.trim(); if (!t) return null; if (!/^https?:\/\//i.test(t)) return 'https://' + t; return t; };
    if (!creatives.length) return new Response(JSON.stringify({error:'No creatives'}),{status:400,headers:{...CORS,'Content-Type':'application/json'}});
    const {data:bd} = await sb.from('creative_batches').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,source_type:'assets',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||null,brand_name:brandName||null,total_creatives:0,dsps_activated:['dv360']}).select('id').single();
    const batchId = bd?.id||null;
    const t0 = Date.now();
    const token = await getToken();
    const results: Result[] = [];
    const videoCreatives = creatives.filter((c:any) => c.type === 'video');
    const otherCreatives = creatives.filter((c:any) => c.type !== 'video');
    for (let i = 0; i < otherCreatives.length; i += 5) {
      const chunk = otherCreatives.slice(i, i + 5);
      const chunkResults = await Promise.all(chunk.map((c:any) => process(token, advId, c, sb)));
      results.push(...chunkResults);
    }
    for (let i = 0; i < videoCreatives.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 3000));
      results.push(await process(token, advId, videoCreatives[i], sb));
    }
    const ok = results.filter(r=>r.success&&r._input);
    if (ok.length>0 && batchId) {
      const rows = ok.map(r=>{
        const i=r._input!;
        const normT = (i.trackers||[]).map(t => normalizeTrackerInput(t)).filter(n => n.url);
        return {batch_id:batchId, created_by_email:user.email!, created_by_name:user.user_metadata?.full_name||user.email,
          dsp:'dv360', dsp_creative_id:String(r.creativeId), name:r.name,
          creative_type:i.type==='video'?'video':i.type==='html5'?'html5':'display',
          dimensions:i.dimensions, js_tag:i.html5PreviewUrl||null, vast_tag:null,
          click_url:normLp(i.landingPage), landing_page:normLp(i.landingPage),
          trackers:normT.length?JSON.stringify(normT):'[]',
          asset_filename:i.fileName, asset_mime_type:i.mimeType, asset_size_bytes:i.fileSize||null,
          dsp_config:JSON.stringify({advertiser_id:advId,storage_path:i.storagePath||null}),
          status:'active', audit_status:'pending', thumbnail_url:i.thumbnailUrl||null, last_synced_at:new Date().toISOString()};
      });
      await sb.from('creatives').insert(rows);
      await sb.from('creative_batches').update({total_creatives:ok.length}).eq('id',batchId);
    }
    const sc=ok.length, st=sc===results.length?'success':sc>0?'partial':'error';
    await sb.from('activation_log').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,
      dsp:'dv360',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||'',
      creatives_count:creatives.length,status:st,
      step:'complete',duration_ms:Date.now()-t0,edge_function:'dsp-dv360-asset',
      request_payload:{advertiserId:advId,type:'asset_upload',creativesCount:creatives.length,batchId},
      response_summary:{total:results.length,success:sc,failed:results.length-sc,batchId,
        creativeIds:results.filter(r=>r.success).map(r=>r.creativeId),
        errors:results.filter(r=>!r.success).map(r=>({name:r.name,error:r.error,step:r.step}))},
      error_message:st==='error'?results[0]?.error:null});
    const clean = results.map(({_input,...rest})=>rest);
    return new Response(JSON.stringify({status:st,total:results.length,success:sc,failed:results.length-sc,batchId,results:clean}),{status:200,headers:{...CORS,'Content-Type':'application/json'}});
  } catch(err) {
    return new Response(JSON.stringify({error:err instanceof Error?err.message:String(err)}),{status:500,headers:{...CORS,'Content-Type':'application/json'}});
  }
});