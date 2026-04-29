import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { cloudinaryTranscodeVideo, getCloudinaryConfig } from "../_shared/cloudinary.ts";

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

interface Input { name:string; type:'display'|'video'|'html5'; dimensions:string; fileName:string; mimeType:string; storagePath?:string; fileBase64?:string; fileSize?:number; landingPage:string; trackers:unknown[]; tracker?:string; duration?:number; thumbnailUrl?:string; html5PreviewUrl?:string; videoStatus?:'ok'|'warn'|'fail'; bitrateKbps?:number; }
interface Result { name:string; success:boolean; creativeId?:number; error?:string; step?:string; _input?:Input; }

// Retorna o asset como Blob (streaming-friendly). Evita alocar Uint8Array gigante em memória
// - crítico para videos grandes, já que edge functions têm limite de ~512MB por isolate.
async function getFileBlob(sb:any, input:Input): Promise<Blob> {
  if (input.storagePath) {
    const {data,error} = await sb.storage.from('asset-uploads').download(input.storagePath);
    if (error||!data) throw new Error(`Storage: ${error?.message||'no data'}`);
    return data as Blob;
  }
  if (input.fileBase64) {
    const b=atob(input.fileBase64); const a=new Uint8Array(b.length);
    for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
    return new Blob([a], { type: input.mimeType });
  }
  throw new Error('No file data');
}

async function processCreative(token:string, advId:number, input:Input, brandUrl:string|null, langId:number, brandId:number|null, sla:number, sb:any): Promise<r> {
  try {
    const [w,h] = input.dimensions.split('x').map(Number);
    const blob = await getFileBlob(sb, input);
    const lp = input.landingPage ? (!/^https?:\/\//i.test(input.landingPage.trim()) ? 'https://' + input.landingPage.trim() : input.landingPage.trim()) : '';
    const rawTrackers = [...(input.trackers||[]), ...(input.tracker?[input.tracker]:[])].filter(Boolean);
    const normalizedTrackers = rawTrackers.map(t => normalizeTrackerInput(t)).filter(n => n.url);
    let assetType = input.type;
    if (input.mimeType?.startsWith('video/') && assetType !== 'video') assetType = 'video';

    const clickDest = lp || brandUrl || '';
    const auditUrl = brandUrl || lp || '';

    console.log(`[xandr-asset] Processing: ${input.name}, type=${assetType}, size=${blob.size}, clickDest=${clickDest}, auditUrl(brandUrl)=${auditUrl}, trackers=${normalizedTrackers.length}`);

    if (assetType === 'html5') {
      // FormData nativo - fetch serializa em stream sem buffer completo na memória
      const fd = new FormData();
      fd.append('type', 'html');
      fd.append('file', new Blob([blob], { type: 'application/zip' }), input.fileName);
      const ur = await fetch(`${XANDR_API}/creative-upload?member_id=${MEMBER_ID}`,{method:'POST',headers:{Authorization:token},body:fd});
      const uploadText = await ur.text();
      let ud; try{ud=JSON.parse(uploadText)}catch{return{name:input.name,success:false,error:`Upload parse: ${uploadText.substring(0,300)}`,step:'upload'}}
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
      // Duration é required pelo VAST. Sem isso, mandar 30s default cria mismatch
      // entre <Duration> no XML e o arquivo real, o que faz alguns players
      // dropparem como "VAST validation error" e quebra serving. Falhar aqui
      // é melhor que criar creative que parece OK mas não entrega.
      if (!input.duration || input.duration <= 0) {
        return { name: input.name, success: false, error: 'Duration ausente ou zero — não foi possível ler metadata do vídeo. Re-importe o arquivo no AdBolt.', step: 'validate' };
      }

      // ── Transcoding via Cloudinary ──
      // Vídeos com bitrate alto (>4 Mbps) ou codec não-H.264 quebram serving:
      // a Xandr aceita o arquivo cru e faz audit, mas o pipeline interno de
      // transcoding tem latência longa (vimos 4 dias num caso real). Durante
      // essa janela, o VAST tem só 1 MediaFile que players de publisher não
      // conseguem tocar a tempo em RTB → line item não entrega.
      //
      // Quando o cliente sinaliza videoStatus=warn|fail, mandamos o arquivo
      // pro Cloudinary primeiro. A Cloudinary devolve uma versão otimizada
      // (1280x720 max, H.264 baseline, 2.5 Mbps, faststart) que segue pra
      // Xandr no lugar do original.
      let videoBlob = blob;
      let videoFileName = input.fileName;
      let videoMimeType = input.mimeType;
      let videoDuration = input.duration;
      const needsTranscode = input.videoStatus === 'warn' || input.videoStatus === 'fail';
      if (needsTranscode) {
        const cloudinaryConfig = getCloudinaryConfig();
        if (!cloudinaryConfig) {
          // Sem Cloudinary configurado, segue com o original. Loga warning pra
          // facilitar debug — o creative pode até passar audit mas vai falhar
          // entrega como antes do fix. Não bloqueia: usuário pode ter setup
          // pendente e a fila precisa continuar funcionando pra outros vídeos.
          console.warn(`[xandr-asset] ${input.name} marcado como ${input.videoStatus} mas Cloudinary não configurado — enviando original (${blob.size} bytes, ${input.bitrateKbps || '?'} kbps)`);
        } else {
          console.log(`[xandr-asset] ${input.name}: transcodando via Cloudinary (input ${blob.size} bytes, ${input.bitrateKbps || '?'} kbps, status=${input.videoStatus})`);
          const tStart = Date.now();
          try {
            const result = await cloudinaryTranscodeVideo(blob, input.fileName, cloudinaryConfig);
            const reduction = Math.round((1 - result.bytes / blob.size) * 100);
            console.log(`[xandr-asset] ${input.name}: transcode OK em ${Date.now() - tStart}ms (${result.bytes} bytes, ${result.bitrateKbps} kbps, -${reduction}%)`);
            videoBlob = result.blob;
            videoFileName = input.fileName.replace(/\.[^.]+$/, '') + '_optimized.mp4';
            videoMimeType = 'video/mp4';
            // Cloudinary devolve duration mais precisa que a leitura via <video> no client
            if (result.durationSeconds > 0) videoDuration = result.durationSeconds;
          } catch (err) {
            // Falha no Cloudinary é fatal pra esse creative — usar o original
            // levaria ao mesmo problema de não-entrega que o fix está resolvendo.
            return { name: input.name, success: false, error: `Cloudinary transcode falhou: ${(err as Error).message}`, step: 'transcode' };
          }
        }
      }

      // FormData nativo - streaming sem estourar memória do isolate
      const fd = new FormData();
      fd.append('type', 'video');
      fd.append('file', new Blob([videoBlob], { type: videoMimeType }), videoFileName);
      const ur = await fetch(`${XANDR_API}/creative-upload?member_id=${MEMBER_ID}`,{method:'POST',headers:{Authorization:token},body:fd});
      const uploadText = await ur.text();
      let ud; try{ud=JSON.parse(uploadText)}catch{return{name:input.name,success:false,error:`Upload parse: ${uploadText.substring(0,300)}`,step:'upload'}}
      const ma = ud.response?.['media-asset']?.[0];
      if (!ma?.id) return {name:input.name,success:false,error:`Upload failed: ${JSON.stringify(ud.response||ud).substring(0,300)}`,step:'upload'};
      const durationMs = videoDuration * 1000;
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
      const vastBody = JSON.stringify({'creative-vast': vastCreative});
      console.log(`[xandr-asset] POST creative-vast: ${vastBody.substring(0,1000)}`);
      const res = await fetch(`${XANDR_API}/creative-vast?member_id=${MEMBER_ID}&advertiser_id=${advId}`,{ method:'POST', headers:{'Content-Type':'application/json',Authorization:token}, body:vastBody });
      const resText = await res.text();
      console.log(`[xandr-asset] Response: ${resText.substring(0,500)}`);
      let rd; try{rd=JSON.parse(resText)}catch{return{name:input.name,success:false,error:`VAST parse: ${resText.substring(0,300)}`,step:'create'}}
      const vc = rd.response?.['creative-vast'];
      if(vc?.id) {
        // Fix crítico: o POST do /creative-vast NÃO popula `categories` no
        // creative, mesmo quando o brand é detected. Sem categories, line items
        // que filtram inventário por categoria IAB não consideram o creative
        // elegível — e a maioria dos publishers premium filtra. Sintoma: audit
        // approved + line item associada + zero entrega.
        //
        // A Xandr detecta o brand via match de nome no nosso input (ex: "HNK_..."
        // → brand_id 4563 = Heineken, com category_id 74). Reutilizamos esse
        // category_id pra setar categories num PUT subsequente. Esse PUT triggera
        // re-classification automática e popula technical_attributes/adservers
        // também.
        const detectedBrandCatId = vc.brand?.category_id;
        if (detectedBrandCatId) {
          try {
            const putBody = JSON.stringify({ 'creative-vast': { categories: [{ id: detectedBrandCatId }] } });
            const putRes = await fetch(`${XANDR_API}/creative-vast?id=${vc.id}&member_id=${MEMBER_ID}&advertiser_id=${advId}`, {
              method: 'PUT', headers: {'Content-Type':'application/json', Authorization: token}, body: putBody,
            });
            const putText = await putRes.text();
            console.log(`[xandr-asset] PUT categories cat_id=${detectedBrandCatId}: ${putText.substring(0,300)}`);
          } catch (err) {
            // Não-fatal: creative já foi criado. Categories pode ser setado depois.
            console.error(`[xandr-asset] PUT categories falhou: ${(err as Error).message}`);
          }
        } else {
          console.warn(`[xandr-asset] Sem brand detected pra ${input.name} — categories ficará vazio (creative pode não entregar)`);
        }
        return {name:input.name,success:true,creativeId:vc.id,_input:input};
      }
      return {name:input.name,success:false,error:`creative-vast: ${rd.response?.error_message||JSON.stringify(rd.response||rd).substring(0,500)}`,step:'create'};

    } else {
      // Display image (template 4) - precisa dos bytes para base64
      const bytes = new Uint8Array(await blob.arrayBuffer());
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
    const {advertiserId=7392214, brandUrl=null, languageId=8, brandId=null, sla=0, campaignName='', advertiserName='', creatives=[], activationSessionId=null} = body;
    const normUrl = (u: string|null) => { if (!u) return null; const t = u.trim(); if (!t) return null; if (!/^https?:\/\//i.test(t)) return 'https://' + t; return t; };
    const safeBrandUrl = normUrl(brandUrl);
    if (!creatives.length) return new Response(JSON.stringify({error:'No creatives'}),{status:400,headers:{...CORS,'Content-Type':'application/json'}});
    const {data:bd} = await sb.from('creative_batches').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,source_type:'assets',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||null,total_creatives:0,dsps_activated:['xandr']}).select('id').single();
    const batchId = bd?.id||null;
    const t0 = Date.now();
    const token = await getXandrToken();
    const results: Result[] = [];
    for (const c of creatives) results.push(await processCreative(token,advertiserId,c,safeBrandUrl,languageId,brandId,sla,sb));
    const ok = results.filter(r=>r.success&&r._input);
    if (ok.length>0 && batchId) {
      const rows = ok.map(r=>{
        const i=r._input!;
        const rawT = [...(i.trackers||[]),...(i.tracker?[i.tracker]:[])].filter(Boolean);
        const normT = rawT.map(t => normalizeTrackerInput(t)).filter(n => n.url);
        return {batch_id:batchId, activation_session_id:activationSessionId||null, created_by_email:user.email!, created_by_name:user.user_metadata?.full_name||user.email,
          dsp:'xandr', dsp_creative_id:String(r.creativeId), name:r.name,
          creative_type:i.type==='video'?'video':i.type==='html5'?'html5':'display',
          dimensions:i.dimensions, js_tag:i.html5PreviewUrl||null, vast_tag:null,
          click_url:normUrl(i.landingPage), landing_page:safeBrandUrl||normUrl(i.landingPage),
          trackers:normT.length?JSON.stringify(normT):'[]',
          asset_filename:i.fileName, asset_mime_type:i.mimeType, asset_size_bytes:i.fileSize||null,
          dsp_config:JSON.stringify({member_id:MEMBER_ID,advertiser_id:advertiserId,language_id:languageId,brand_id:brandId,brand_url:safeBrandUrl,sla,storage_path:i.storagePath||null}),
          status:'active', audit_status:'pending', thumbnail_url:i.thumbnailUrl||null, last_synced_at:new Date().toISOString()};
      });
      await sb.from('creatives').insert(rows);
      await sb.from('creative_batches').update({total_creatives:ok.length}).eq('id',batchId);
    }
    const sc=ok.length, st=sc===results.length?'success':sc>0?'partial':'error';
    await sb.from('activation_log').insert({user_email:user.email,user_name:user.user_metadata?.full_name||user.email,
      dsp:'xandr',campaign_name:campaignName||'Asset Upload',advertiser_name:advertiserName||'',
      creatives_count:creatives.length,status:st,
      step:'complete',duration_ms:Date.now()-t0,edge_function:'dsp-xandr-asset',
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
