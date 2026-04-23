import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getDV360Token, DV360_API } from "../_shared/dv360-auth.ts";

const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, content-type, x-client-info, apikey","Access-Control-Allow-Methods":"POST, OPTIONS"};

function normalizeTrackerInput(t: unknown): {url: string; format: string; eventType?: string} {
  if (typeof t === 'string') return {url: t, format: 'url-image'};
  const obj = t as {url?: string; format?: string; eventType?: string};
  return {url: obj.url || '', format: obj.format || 'url-image', eventType: obj.eventType};
}

interface Input { name:string; type:'display'|'video'|'html5'; dimensions:string; fileName:string; mimeType:string; storagePath?:string; fileBase64?:string; fileSize?:number; landingPage:string; trackers?:unknown[]; duration?:number; thumbnailUrl?:string; html5PreviewUrl?:string; }
interface Result { name:string; success:boolean; creativeId?:string; error?:string; step?:string; _input?:Input; }

// Retorna o asset como Blob (streaming-friendly). Evita alocar Uint8Array gigante em memória
// - crítico para videos grandes, já que edge functions têm limite de ~512MB por isolate.
async function getFileBlob(sb: any, input: Input): Promise<Blob> {
  if (input.storagePath) {
    const { data, error } = await sb.storage.from('asset-uploads').download(input.storagePath);
    if (error || !data) throw new Error(`Storage download: ${error?.message || 'no data'}`);
    return data as Blob;
  }
  if (input.fileBase64) {
    const b = atob(input.fileBase64); const arr = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
    return new Blob([arr], { type: input.mimeType });
  }
  throw new Error('No file data');
}

async function process(token: string, advId: string, input: Input, sb: any): Promise<r> {
  try {
    const blob = await getFileBlob(sb, input);
    const isVideo = input.type === 'video';
    const [w,h] = input.dimensions.split('x').map(Number);
    const normalizedTrackers = (input.trackers||[]).map(t => normalizeTrackerInput(t)).filter(n => n.url);
    const lp = input.landingPage ? (!/^https?:\/\//i.test(input.landingPage.trim()) ? 'https://' + input.landingPage.trim() : input.landingPage.trim()) : '';
    const DV360_EVENT_MAP: Record<string, string> = {
      impression: 'THIRD_PARTY_URL_TYPE_IMPRESSION',
      start: 'THIRD_PARTY_URL_TYPE_AUDIO_VIDEO_START',
      first_quartile: 'THIRD_PARTY_URL_TYPE_AUDIO_VIDEO_FIRST_QUARTILE',
      midpoint: 'THIRD_PARTY_URL_TYPE_AUDIO_VIDEO_MIDPOINT',
      third_quartile: 'THIRD_PARTY_URL_TYPE_AUDIO_VIDEO_THIRD_QUARTILE',
      completion: 'THIRD_PARTY_URL_TYPE_AUDIO_VIDEO_COMPLETE',
      click: 'THIRD_PARTY_URL_TYPE_CLICK_TRACKING',
      skip: 'THIRD_PARTY_URL_TYPE_AUDIO_VIDEO_SKIP',
      error: 'THIRD_PARTY_URL_TYPE_IMPRESSION',
    };
    const allTrackerUrls: Array<{type: string; url: string}> = [];
    const seen = new Set<string>();
    for (const t of normalizedTrackers) {
      const key = t.url + '|' + (t.eventType || 'impression');
      if (seen.has(key)) continue;
      seen.add(key);
      const dv360Type = isVideo
        ? (DV360_EVENT_MAP[t.eventType || 'impression'] || 'THIRD_PARTY_URL_TYPE_IMPRESSION')
        : 'THIRD_PARTY_URL_TYPE_IMPRESSION';
      allTrackerUrls.push({type: dv360Type, url: t.url});
    }
    console.log(`[dv360-asset] Uploading ${input.fileName} (${blob.size} bytes, ${input.mimeType}), type=${input.type}, trackers=${allTrackerUrls.length}, events=${allTrackerUrls.map(t=>t.type).join(',')}`);
    if (isVideo && blob.size < 1000) { return {name:input.name, success:false, error:`File too small (${blob.size} bytes)`, step:'validate'}; }

    // FormData nativo: fetch serializa em stream sem materializar body completo na memória.
    // Google DV360 aceita multipart padrão; o Blob "data" carrega Content-Type aplicação/json explícito.
    const fd = new FormData();
    fd.append('data', new Blob([JSON.stringify({filename: input.fileName})], { type: 'application/json; charset=UTF-8' }));
    fd.append('file', new Blob([blob], { type: input.mimeType }), input.fileName);

    const uploadRes = await fetch(
      `https://displayvideo.googleapis.com/upload/v4/advertisers/${advId}/assets?uploadType=multipart`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }
    );
    const uploadText = await uploadRes.text();
    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch { return {name:input.name, success:false, error:`Upload parse: ${uploadText.substring(0,200)}`, step:'upload'}; }
    const mediaId = uploadData.asset?.mediaId;
    if (!mediaId) return {name:input.name, success:false, error:`No mediaId: ${uploadData.error?.message || uploadText.substring(0,200)}`, step:'upload'};

    // Source of truth: read actual dimensions from file bytes (display only - videos skip this)
    let realW = w, realH = h;
    if (!isVideo) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      if (isJpeg) {
        let i = 2;
        while (i < bytes.length - 9) {
          if (bytes[i] !== 0xFF) break;
          const marker = bytes[i + 1];
          if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
            realH = (bytes[i + 5] << 8) | bytes[i + 6];
            realW = (bytes[i + 7] << 8) | bytes[i + 8];
            break;
          }
          const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
          i += 2 + segLen;
        }
      } else if (isPng && bytes.length > 24) {
        realW = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
        realH = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      }
      if (realW !== w || realH !== h) {
        console.log(`[dv360-asset] Dimensions from file bytes: ${realW}x${realH} (frontend declared ${w}x${h}) for ${input.name}`);
      }
    }

    const creative: Record<string,unknown> = {
      displayName: input.name, entityStatus: 'ENTITY_STATUS_ACTIVE', hostingSource: 'HOSTING_SOURCE_HOSTED',
      creativeType: isVideo ? 'CREATIVE_TYPE_VIDEO' : 'CREATIVE_TYPE_STANDARD',
      assets: [{asset:{mediaId}, role:'ASSET_ROLE_MAIN'}],
      exitEvents: [{name:'Landing Page', type:'EXIT_EVENT_TYPE_DEFAULT', url:lp||'https://example.com'}]
    };
    if (!isVideo) creative.dimensions = {widthPixels: realW || 1, heightPixels: realH || 1};
    if (allTrackerUrls.length) {
      if (isVideo) {
        creative.thirdPartyUrls = allTrackerUrls.map(t => ({ type: t.type, url: t.url }));
      } else {
        const tagParts = allTrackerUrls.map(t => {
          const lower = t.url.toLowerCase();
          if (lower.endsWith('.js') || lower.includes('.js?') || lower.includes('/js/')) {
            return `<scr` + `ipt src="${t.url}"></scr` + `ipt>`;
          }
          return `<img src="${t.url}" width="1" height="1" style="display:none" />`;
        });
        creative.appendedTag = tagParts.join('\n');
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
    const {campaignName='',advertiserName='',brandName='',creatives=[],activationSessionId=null} = body;
    const normLp = (u: string|null|undefined) => { if (!u) return null; const t = u.trim(); if (!t) return null; if (!/^https?:\/\//i.test(t)) return 'https://' + t; return t; };
    if (!creatives.length) return new Response(JSON.stringify({error:'No creatives'}),{status:400,headers:{...CORS,'Content-Type':'application/json'}});
    const {data:bd} = await sb.from('creative_batches').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,source_type:'assets',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||null,brand_name:brandName||null,total_creatives:0,dsps_activated:['dv360']}).select('id').single();
    const batchId = bd?.id||null;
    const t0 = Date.now();
    const token = await getDV360Token();
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
        return {batch_id:batchId, activation_session_id:activationSessionId||null, created_by_email:user.email!, created_by_name:user.user_metadata?.full_name||user.email,
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
