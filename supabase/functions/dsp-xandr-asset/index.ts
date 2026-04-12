import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

const XANDR_API = "https://api.appnexus.com";
const MEMBER_ID = 14843;
const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, content-type, x-client-info, apikey","Access-Control-Allow-Methods":"POST, OPTIONS"};

let cachedToken: string|null = null, tokenExp = 0;

async function getXandrToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExp) return cachedToken;
  const u = Deno.env.get('XANDR_USERNAME'), p = Deno.env.get('XANDR_PASSWORD');
  if (!u||!p) throw new Error('XANDR credentials not set');
  const r = await fetch(`${XANDR_API}/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auth:{username:u,password:p}})});
  const d = await r.json();
  if (!d.response?.token) throw new Error(`Auth failed: ${JSON.stringify(d)}`);
  cachedToken = d.response.token; tokenExp = Date.now()+110*60*1000;
  return cachedToken!;
}

function pixelFormat(url:string):string { const l=url.toLowerCase(); if(l.startsWith('<script')&&!l.includes('src='))return'raw-js'; if(l.endsWith('.js')||l.includes('.js?')||l.includes('/js/'))return'url-js'; if(l.includes('.html'))return'url-html'; return'url-image'; }

function normalizeTrackerInput(t: unknown): {url: string; format: string; eventType?: string} {
  if (typeof t === 'string') return {url: t, format: pixelFormat(t)};
  const obj = t as {url?: string; format?: string; eventType?: string};
  return {url: obj.url || '', format: obj.format || pixelFormat(obj.url || ''), eventType: obj.eventType};
}

interface Input { name:string; type:'display'|'video'|'html5'; dimensions:string; fileName:string; mimeType:string; storagePath?:string; fileBase64?:string; fileSize?:number; landingPage:string; trackers:unknown[]; tracker?:string; duration?:number; thumbnailUrl?:string; html5PreviewUrl?:string; }
interface Result { name:string; success:boolean; creativeId?:number; error?:string; step?:string; _input?:Input; }

async function getFileBytes(sb:any, input:Input): Promise<Uint8Array> {
  if (input.storagePath) {
    const {data,error} = await sb.storage.from('asset-uploads').download(input.storagePath);
    if (error||!data) throw new Error(`Storage: ${error?.message||'no data'}`);
    return new Uint8Array(await data.arrayBuffer());
  }
  if (input.fileBase64) { const b=atob(input.fileBase64); const a=new Uint8Array(b.length); for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i); return a; }
  throw new Error('No file data');
}

async function processCreative(token:string, advId:number, input:Input, brandUrl:string|null, langId:number, brandId:number|null, sla:number, sb:any): Promise<Result> {
  try {
    const [w,h] = input.dimensions.split('x').map(Number);
    const bytes = await getFileBytes(sb, input);
    // Normalize landingPage URL
    const lp = input.landingPage ? (!/^https?:\/\//i.test(input.landingPage.trim()) ? 'https://' + input.landingPage.trim() : input.landingPage.trim()) : '';
    const rawTrackers = [...(input.trackers||[]), ...(input.tracker?[input.tracker]:[])].filter(Boolean);
    const normalizedTrackers = rawTrackers.map(t => normalizeTrackerInput(t)).filter(n => n.url);
    let assetType = input.type;
    if (input.mimeType?.startsWith('video/') && assetType !== 'video') assetType = 'video';

    // Derive click destination and audit URL consistently:
    // - clickDest: where the user goes when clicking the ad (asset landing page, fallback to brandUrl)
    // - auditUrl: brand URL for Xandr audit review (brandUrl, fallback to landing page)
    const clickDest = lp || brandUrl || '';
    const auditUrl = brandUrl || lp || '';

    console.log(`[xandr-asset] Processing: ${input.name}, type=${assetType}, size=${bytes.length}, clickDest=${clickDest}, auditUrl(brandUrl)=${auditUrl}, trackers=${normalizedTrackers.length}`);

    if (assetType === 'html5') {
      const boundary = '----XH5'+Date.now();
      const enc = new TextEncoder();
      const parts: Uint8Array[] = [];
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nhtml\r\n`));
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName}"\r\nContent-Type: application/zip\r\n\r\n`));
      parts.push(bytes);
      parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
      const len=parts.reduce((s,p)=>s+p.length,0); const body=new Uint8Array(len); let o=0; for(const p of parts){body.set(p,o);o+=p.length}
      const ur = await fetch(`${XANDR_API}/creative-upload?member_id=${MEMBER_ID}`,{method:'POST',headers:{Authorization:token,'Content-Type':`multipart/form-data; boundary=${boundary}`},body});
      const ud = await ur.json();
      const ma = ud.response?.['media-asset']?.[0];
      if (!ma?.id) return {name:input.name,success:false,error:`Upload: ${JSON.stringify(ud.response||ud).substring(0,500)}`,step:'upload'};
      const cr:Record<string,unknown> = {
        name:input.name, advertiser_id:advId, width:w, height:h,
        template:{id:8606}, media_assets:[{media_asset_id:ma.id}],
        click_url: clickDest,
        landing_page_url: auditUrl,
        brand_url: auditUrl,
        mobile: auditUrl ? { alternative_landing_page_url: auditUrl } : undefined,
        allow_audit:true, allow_ssl_audit:true, is_self_audited:false, sla:sla||0
      };
      if(langId)cr.language={id:langId}; if(brandId)cr.brand_id=brandId;
      if(normalizedTrackers.length)cr.pixels=normalizedTrackers.slice(0,5).map(t=>({url:t.url,secure_url:t.url.replace(/^http:/,'https:'),format:t.format}));
      const res = await fetch(`${XANDR_API}/creative-html?member_id=${MEMBER_ID}&advertiser_id=${advId}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:token},body:JSON.stringify({'creative-html':cr})});
      const rd = await res.json();
      if(rd.response?.['creative-html']?.id) return {name:input.name,success:true,creativeId:rd.response['creative-html'].id,_input:input};
      return {name:input.name,success:false,error:rd.response?.error_message||JSON.stringify(rd.response||rd).substring(0,500),step:'create'};

    } else if (assetType === 'video') {
      console.log(`[xandr-asset] VIDEO upload for ${input.name}`);
      const boundary = '----XV'+Date.now();
      const enc = new TextEncoder();
      const parts: Uint8Array[] = [];
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nvideo\r\n`));
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`));
      parts.push(bytes);
      parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
      const len=parts.reduce((s,p)=>s+p.length,0); const body=new Uint8Array(len); let o=0; for(const p of parts){body.set(p,o);o+=p.length}
      const ur = await fetch(`${XANDR_API}/creative-upload?member_id=${MEMBER_ID}`,{method:'POST',headers:{Authorization:token,'Content-Type':`multipart/form-data; boundary=${boundary}`},body});
      const uploadText = await ur.text();
      let ud; try{ud=JSON.parse(uploadText)}catch{return{name:input.name,success:false,error:`Upload parse: ${uploadText.substring(0,300)}`,step:'upload'}}
      const ma = ud.response?.['media-asset']?.[0];
      if (!ma?.id) return {name:input.name,success:false,error:`Upload failed: ${JSON.stringify(ud.response||ud).substring(0,300)}`,step:'upload'};
      const durationMs = (input.duration || 30) * 1000;
      const inlineObj: Record<string, unknown> = { ad_title: input.name };
      if (normalizedTrackers.length > 0) {
        const VAST_EVENT_MAP: Record<string, string> = {
          impression: 'impression', start: 'start', skip: 'skip', error: 'error',
          first_quartile: 'first_quartile', midpoint: 'midpoint', third_quartile: 'third_quartile',
          completion: 'completion', click: 'click',
        };
        inlineObj.linear = {
          trackers: normalizedTrackers.slice(0, 5).map((t, i) => ({
            name: `tracker_${i}`,
            vast_event_type: VAST_EVENT_MAP[t.eventType || 'impression'] || 'impression',
            url: t.url,
            secure_url: t.url.replace(/^http:/, 'https:'),
          })),
        };
      }
      const vastCreative: Record<string,unknown> = {
        name: input.name, advertiser_id: advId, template: {id: 6439},
        media_assets: [{media_asset_id: ma.id}],
        click_url: clickDest, click_target: clickDest,
        landing_page_url: auditUrl,
        mobile: auditUrl ? { alternative_landing_page_url: auditUrl } : undefined,
        video_attribute: { duration_ms: durationMs, is_skippable: false, inline: inlineObj },
        allow_audit: true, allow_ssl_audit: true, is_self_audited: false, sla: sla || 0
      };
      if(langId) vastCreative.language = {id: langId};
      if(brandId) vastCreative.brand_id = brandId;
      if(normalizedTrackers.length) { vastCreative.pixels = normalizedTrackers.slice(0,5).map(t => ({ url: t.url, secure_url: t.url.replace(/^http:/, 'https:'), format: t.format })); }
      const vastBody = JSON.stringify({'creative-vast': vastCreative});
      console.log(`[xandr-asset] POST creative-vast: ${vastBody.substring(0,1000)}`);
      const res = await fetch(`${XANDR_API}/creative-vast?member_id=${MEMBER_ID}&advertiser_id=${advId}`,{ method:'POST', headers:{'Content-Type':'application/json',Authorization:token}, body:vastBody });
      const resText = await res.text();
      console.log(`[xandr-asset] Response: ${resText.substring(0,500)}`);
      let rd; try{rd=JSON.parse(resText)}catch{return{name:input.name,success:false,error:`VAST parse: ${resText.substring(0,300)}`,step:'create'}}
      const vc = rd.response?.['creative-vast'];
      if(vc?.id) return {name:input.name,success:true,creativeId:vc.id,_input:input};
      return {name:input.name,success:false,error:`creative-vast: ${rd.response?.error_message||JSON.stringify(rd.response||rd).substring(0,500)}`,step:'create'};

    } else {
      // Display image (template 4)
      const b64 = base64Encode(bytes);
      const cr:Record<string,unknown> = {
        name:input.name, advertiser_id:advId, width:w, height:h,
        template:{id:4}, format:'image', content:b64, file_name:input.fileName,
        click_url: clickDest,
        landing_page_url: auditUrl,
        brand_url: auditUrl,
        mobile: auditUrl ? { alternative_landing_page_url: auditUrl } : undefined,
        audit_status:'pending', allow_audit:true, allow_ssl_audit:true, is_self_audited:false, sla:sla||0
      };
      if(langId)cr.language={id:langId}; if(brandId)cr.brand_id=brandId;
      if(normalizedTrackers.length)cr.pixels=normalizedTrackers.slice(0,5).map(t=>({url:t.url,secure_url:t.url.replace(/^http:/,'https:'),format:t.format}));
      const res = await fetch(`${XANDR_API}/creative?member_id=${MEMBER_ID}&advertiser_id=${advId}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:token},body:JSON.stringify({creative:cr})});
      const rd = await res.json();
      if(rd.response?.status==='OK'&&rd.response?.creative) return {name:input.name,success:true,creativeId:rd.response.creative.id,_input:input};
      return {name:input.name,success:false,error:rd.response?.error_message||JSON.stringify(rd.response||rd).substring(0,300),step:'create'};
    }
  } catch(err) {
    return {name:input.name,success:false,error:err instanceof Error?err.message:String(err),step:'exception'};
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
    const {advertiserId=7392214, brandUrl=null, languageId=8, brandId=null, sla=0, campaignName='', advertiserName='', creatives=[]} = body;
    // Normalize URLs: add https:// if missing protocol
    const normUrl = (u: string|null) => { if (!u) return null; const t = u.trim(); if (!t) return null; if (!/^https?:\/\//i.test(t)) return 'https://' + t; return t; };
    const safeBrandUrl = normUrl(brandUrl);
    if (!creatives.length) return new Response(JSON.stringify({error:'No creatives'}),{status:400,headers:{...CORS,'Content-Type':'application/json'}});
    const {data:bd} = await sb.from('creative_batches').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,source_type:'assets',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||null,total_creatives:0,dsps_activated:['xandr']}).select('id').single();
    const batchId = bd?.id||null;
    const token = await getXandrToken();
    const results: Result[] = [];
    for (const c of creatives) results.push(await processCreative(token,advertiserId,c,safeBrandUrl,languageId,brandId,sla,sb));
    const ok = results.filter(r=>r.success&&r._input);
    if (ok.length>0 && batchId) {
      const rows = ok.map(r=>{
        const i=r._input!;
        const rawT = [...(i.trackers||[]),...(i.tracker?[i.tracker]:[])].filter(Boolean);
        const normT = rawT.map(t => normalizeTrackerInput(t)).filter(n => n.url);
        return {batch_id:batchId, created_by_email:user.email!, created_by_name:user.user_metadata?.full_name||user.email,
          dsp:'xandr', dsp_creative_id:String(r.creativeId), name:r.name,
          creative_type:i.type==='video'?'video':i.type==='html5'?'html5':'display',
          dimensions:i.dimensions, js_tag:i.html5PreviewUrl||null, vast_tag:null,
          click_url:normUrl(i.landingPage), landing_page:safeBrandUrl||normUrl(i.landingPage),
          trackers:normT.length?JSON.stringify(normT):'[]',
          asset_filename:i.fileName, asset_mime_type:i.mimeType, asset_size_bytes:i.fileSize||null,
          dsp_config:JSON.stringify({member_id:MEMBER_ID,advertiser_id:advertiserId,language_id:languageId,brand_id:brandId,brand_url:safeBrandUrl,sla}),
          status:'active', audit_status:'pending', thumbnail_url:i.thumbnailUrl||null, last_synced_at:new Date().toISOString()};
      });
      await sb.from('creatives').insert(rows);
      await sb.from('creative_batches').update({total_creatives:ok.length}).eq('id',batchId);
    }
    const sc=ok.length, st=sc===results.length?'success':sc>0?'partial':'error';
    await sb.from('activation_log').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,
      dsp:'xandr',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||'',
      creatives_count:creatives.length,status:st,
      request_payload:{advertiserId,type:'asset_upload',creativesCount:creatives.length,batchId},
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
