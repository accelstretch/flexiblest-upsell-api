import { createHash, randomUUID } from 'node:crypto';
import { redis as liveRedis } from './paypro-financials.js';

export const PREFIX = 'paypro:recovery:v1:';
// Pending payloads do not expire silently. They are deleted on completion;
// completion records contain no customer data and expire after 400 days.
export const ENQUEUE = `
if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS',KEYS[1]) == 0 then redis.call('SET',KEYS[1],ARGV[1]) end
redis.call('ZADD',KEYS[3],'NX',ARGV[2],ARGV[3])
return 1`;
export const FINISH = `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'done' then
 redis.call('SET',KEYS[3],'1','EX',34560000)
 redis.call('DEL',KEYS[2])
 redis.call('ZREM',KEYS[4],ARGV[3])
else
 redis.call('ZADD',KEYS[4],ARGV[4],ARGV[3])
end
redis.call('DEL',KEYS[1])
return 1`;

export function jobId(data) {
  // Different refund amounts/signatures must never collapse into one job.
  const identity = ['ORDER_ID','ORDER_ITEM_ID','PRODUCT_ID','IPN_TYPE_NAME','SIGNATURE']
    .map(k=>String(data[k] ?? '')).join('|');
  return createHash('sha256').update(identity).digest('hex');
}
export async function enqueueSigned(data, {store=liveRedis, now=Date.now}={}) {
  const id=jobId(data);
  const job={data,created:now()};
  if(Buffer.byteLength(JSON.stringify(job))>128*1024) throw new Error('recovery_payload_too_large');
  await store(['EVAL',ENQUEUE,'3',PREFIX+'job:'+id,PREFIX+'done:'+id,PREFIX+'due',JSON.stringify(job),String(now()),id]);
  return id;
}
export function completed(result) {
  if(result.code!==200 || result.body?.ok!==true) return false;
  const b=result.body;
  if(b.processing || b.reason==='secure_session_rejected') return false;
  if(b.reason==='checkout_bump_item_ipn') return b.kajabi_access_updated===true || b.kajabi_already_updated===true;
  if(b.secure_session_verified && !b.test_mode && !b.duplicate_charge_detected)
    return (b.sent_to_cometly===true || b.already_sent===true) && (b.kajabi_access_updated===true || b.kajabi_already_updated===true);
  return b.skipped===true || b.test_mode===true || b.duplicate_charge_detected===true;
}
export function responseBuffer() {
  return {code:200,body:null,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
}
export async function processJob(id, process, {store=liveRedis,now=Date.now}={}) {
  const lock=PREFIX+'lock:'+id, token=randomUUID();
  // Longer than the configured worker duration; never delete another lease.
  if(await store(['SET',lock,token,'NX','EX','360'])!=='OK') return {busy:true};
  let done=false;
  try {
    const raw=await store(['GET',PREFIX+'job:'+id]);
    if(!raw) done=Boolean(await store(['GET',PREFIX+'done:'+id]));
    else done=completed(await process(JSON.parse(raw).data));
    return {done};
  } finally {
    const saved=await store(['EVAL',FINISH,'4',lock,PREFIX+'job:'+id,PREFIX+'done:'+id,PREFIX+'due',token,done?'done':'retry',id,String(now()+300000)]);
    if(saved!==1) throw new Error('recovery_lease_lost');
  }
}
export async function drain(process,{store=liveRedis,now=Date.now,limit=5,deadline=Infinity}={}) {
  const ids=await store(['ZRANGEBYSCORE',PREFIX+'due','-inf',String(now()),'LIMIT','0',String(limit)]);
  let done=0,retry=0;
  for(const id of ids) {
    if(now()>deadline) break;
    try {const r=await processJob(id,process,{store,now});if(r.done)done++;else retry++;}
    catch {retry++;}
  }
  return {done,retry};
}
