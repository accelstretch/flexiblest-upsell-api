import { randomUUID } from 'node:crypto';
import { buildOpenAIEvent, sendOpenAI, DAY } from './openai-conversions.js';
export const PREFIX = 'paypro:openai:v1:';
export const ENQUEUE = `
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS',KEYS[1]) == 0 then
 redis.call('SET',KEYS[1],ARGV[1],'EX',604800)
end
redis.call('ZADD',KEYS[3],'NX',ARGV[2],ARGV[3])
return 1`;
export const FINISH = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'sent' or ARGV[2] == 'skipped' then
 redis.call('SET',KEYS[3],ARGV[3],'NX','EX',34560000)
 redis.call('DEL',KEYS[2])
 redis.call('ZREM',KEYS[4],ARGV[4])
elseif redis.call('EXISTS',KEYS[2]) == 1 then
 redis.call('SET',KEYS[2],ARGV[3],'KEEPTTL')
 redis.call('ZADD',KEYS[4],ARGV[5],ARGV[4])
else
 redis.call('ZREM',KEYS[4],ARGV[4])
end
redis.call('DEL',KEYS[1])
return 1`;
export const FREEZE = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('EXISTS',KEYS[2]) == 0 then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'KEEPTTL')
return 1`;
export async function redis(command) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('missing_queue_configuration');
  const response = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(command),signal:AbortSignal.timeout(8000) });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('queue_unavailable');
  return data.result;
}
export async function recoverSessions(store = redis) {
  // Recover a missing journal/queue write from the authoritative paid-session snapshot.
  const cursor = await store(['GET',PREFIX+'cursor']) || '0';
  const [next, keys] = await store(['SCAN',cursor,'MATCH','paypro:funnel:session:*','COUNT','100']);
  const values = keys.length ? await store(['MGET', ...keys]) : [];
  for (const raw of values) {
    if (!raw) continue;
    const s = JSON.parse(raw), p = s.openai_payment;
    if (!p || !s.paypro_root_order_id || s.openai?.allowed !== true) continue;
    const id = s.paypro_root_order_id;
    await store(['EVAL',ENQUEUE,'3',PREFIX+'job:'+id,PREFIX+'done:'+id,PREFIX+'due',JSON.stringify({payment:p,session:{paypro_root_order_id:id,openai:s.openai,request_context:s.request_context},attempts:0}),String(Date.now()),id]);
  }
  await store(['SET',PREFIX+'cursor',String(next)]);
  return keys.length;
}
export async function runWorker({store=redis, sender=sendOpenAI, now=Date.now, env=process.env}={}) {
  if (!['live','validate'].includes(env.OPENAI_ADS_MODE) || env.VERCEL_ENV !== 'production') return {disabled:true};
  if (!env.OPENAI_CONVERSIONS_API_KEY || !env.OPENAI_ADS_PIXEL_ID) throw new Error('missing_openai_configuration');
  const recovered = await recoverSessions(store);
  const ids = await store(['ZRANGEBYSCORE',PREFIX+'due','-inf',String(now()),'LIMIT','0','10']);
  const result = {recovered, sent:0, retried:0, skipped:0, validated:0};
  for(const id of ids) {
    const jobKey=PREFIX+'job:'+id,doneKey=PREFIX+'done:'+id,lockKey=PREFIX+'lock:'+id, token=randomUUID();
    if (await store(['SET',lockKey,token,'NX','EX','120']) !== 'OK') continue;
    const raw=await store(['GET',jobKey]);
    let job=raw?JSON.parse(raw):null, state='retry', code='';
    if(await store(['EXISTS',doneKey]) || await store(['EXISTS',PREFIX+'revoked:'+id]) || !job) {state='skipped';code='missing_or_completed';}
    else {
      try {
        if (!job.event) job.event=buildOpenAIEvent(job,now());
        if (!job.event) {state='skipped';code='ineligible';}
        else if(job.event.timestamp_ms<=now()-7*DAY) {state='skipped';code='expired';}
        else {
          // Freeze before sending; retries cannot invent a new event ID or timestamp.
          if(await store(['EVAL',FREEZE,'2',lockKey,jobKey,token,JSON.stringify(job)])!==1) throw new Error('queue_lease_lost');
          if(await store(['EXISTS',PREFIX+'revoked:'+id])) { state='skipped'; code='revoked'; }
          else {
          const delivery=await sender(job.event,{env,validateOnly:env.OPENAI_ADS_MODE==='validate'});
          if(delivery.ok) {state=env.OPENAI_ADS_MODE==='live'?'sent':'validated';code='accepted';}
          else {code='http_'+delivery.status;state=delivery.status===429||delivery.status>=500?'retry':'review';}
          }
        }
      } catch(error) {code=['invalid_amount','invalid_currency','amount_precision','invalid_time','event_time_out_of_range'].includes(error.message)?error.message:'delivery_or_storage_failed';state=code==='delivery_or_storage_failed'?'retry':'review';}
    }
    const attempts=(job?.attempts||0)+1;
    const next=now()+(state==='review'||state==='validated'?3600000:Math.min(3600000,30000*2**Math.min(attempts,7))+Math.floor(Math.random()*10000));
    const terminal=state==='sent'||state==='skipped';
    const value=terminal?{state,code,at:now()}:{...job,attempts,state,code};
    const saved=await store(['EVAL',FINISH,'4',lockKey,jobKey,doneKey,PREFIX+'due',token,terminal?state:'retry',JSON.stringify(value),id,String(next)]);
    if(saved!==1) throw new Error('queue_lease_lost');
    result[state==='sent'?'sent':state==='skipped'?'skipped':state==='validated'?'validated':'retried']++;
  }
  await store(['SET',PREFIX+'health',JSON.stringify({...result,at:now()}),'EX','86400']);
  return result;
}
