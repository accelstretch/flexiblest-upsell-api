import { timingSafeEqual } from 'node:crypto';
import { redis, getOrder } from '../lib/paypro-financials.js';
import { drain, PREFIX, completed } from '../lib/paypro-recovery.js';
import { processSignedNotification, reconcilePaidOrder } from './paypro-webhook.js';

export async function listOrders(from,to) {
  const ids=new Set();let skip=0,expected;
  for(let page=0;page<20;page++) {
    const response=await fetch('https://store.payproglobal.com/api/Orders/GetList',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({vendorAccountId:Number(process.env.PAYPRO_VENDOR_ACCOUNT_ID),
        apiSecretKey:process.env.PAYPRO_API_SECRET_KEY,skip,take:100,sortByDate:'asc',includeTestOrders:false,
        search:{dateFrom:new Date(from).toISOString().replace('Z',''),dateTo:new Date(to).toISOString().replace('Z','')}})
    });
    const data=await response.json(),r=data.response;
    if(!response.ok||data.isSuccess!==true||!Array.isArray(r?.orders)||!Number.isSafeInteger(r.totalCount))
      throw new Error('recovery_order_list_unavailable');
    if(expected!==undefined&&r.totalCount!==expected)throw new Error('recovery_order_list_changed');
    expected=r.totalCount;
    for(const o of r.orders){if(!/^\d+$/.test(String(o.id)))throw new Error('recovery_invalid_order_id');ids.add(String(o.id));}
    skip+=r.orders.length;
    if(skip>=expected){if(ids.size!==expected)throw new Error('recovery_order_list_incomplete');return [...ids];}
    if(!r.orders.length)break;
  }
  throw new Error('recovery_order_list_incomplete');
}
// The release boundary prevents replay of older manually fulfilled orders.
// Redis preserves this boundary across subsequent deployments.
export const RELEASE_START = Date.parse('2026-10-11T03:50:00Z');
export const DISCOVER = `
for i=2,#ARGV do
 if redis.call('EXISTS',KEYS[3]..ARGV[i]) == 0 then
  redis.call('ZADD',KEYS[1],'NX',0,ARGV[i])
 end
end
redis.call('SET',KEYS[2],ARGV[1])
return #ARGV-1`;
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({ok:false});
  const expected='Bearer '+(process.env.CRON_SECRET||''), actual=String(req.headers.authorization||'');
  if(!process.env.CRON_SECRET||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||
    !timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return res.status(401).json({ok:false});
  if(process.env.VERCEL_ENV!=='production'||process.env.PAYPRO_RECOVERY_DISABLED==='1')
    return res.status(200).json({ok:true,disabled:true});
  try {
    const now=Date.now(),deadline=now+150000;
    await redis(['SET',PREFIX+'started',String(RELEASE_START),'NX']);
    const start=Number(await redis(['GET',PREFIX+'started']));
    if(!Number.isFinite(start)||start<=0)throw new Error('recovery_start_invalid');
    // First release is read-only toward destinations until production API shape
    // has been verified. No old orders are replayed by this probe.
    if(process.env.PAYPRO_RECOVERY_MODE!=='active') {
      const ids=await listOrders(now-86400000,now-300000);
      let valid=0,review=0;const shapes=new Set();
      for(const id of ids.slice(-3)) {
        try {const r=await reconcilePaidOrder(id,now-86400000,{audit:true});if(r.audit){valid++;shapes.add(r.custom_fields_shape);}else review++;}
        catch {review++;}
      }
      const result={ok:true,mode:'audit',sampled:Math.min(3,ids.length),valid,review,shapes:[...shapes]};
      console.log('PAYPRO RECOVERY SCHEMA AUDIT',result);return res.status(200).json(result);
    }
    let discovered=0;
    if(process.env.PAYPRO_RECONCILE_DISABLED!=='1') {
      const cursor=Number(await redis(['GET',PREFIX+'scanned-through'])||start);
      if(!Number.isFinite(cursor)||cursor<start)throw new Error('recovery_cursor_invalid');
      // Advance a durable cursor only after the complete page set is saved.
      // The overlap catches transient visibility lag; pending IDs never expire.
      const until=Math.min(now-300000,cursor+86400000);
      if(until>cursor) {
        const ids=await listOrders(Math.max(start,cursor-3600000),until);
        discovered=await redis(['EVAL',DISCOVER,'3',PREFIX+'orders-due',PREFIX+'scanned-through',PREFIX+'order-done:',String(until),...ids]);
      }
    }
    const queued=await drain(async data=>{
      let time=String(data.ORDER_PLACED_TIME_UTC||'');if(time&&!/(Z|[+-]\d\d:\d\d)$/.test(time))time+='Z';
      const placed=Date.parse(time);
      if(!Number.isFinite(placed)||placed<Date.now()-7*86400000) throw new Error('recovery_event_age_requires_review');
      const order=await getOrder(data.ORDER_ID);
      if(String(order.orderId)!==String(data.ORDER_ID)||order.isTestMode!==false||order.orderStatusId!==5||Number(order.billingRefundedAmount)!==0)
        throw new Error('recovery_charge_requires_review');
      return processSignedNotification(data);
    },{limit:2,deadline});
    let checked=0,recovered=0,review=0;
    if(process.env.PAYPRO_RECONCILE_DISABLED!=='1') {
      const ids=await redis(['ZRANGEBYSCORE',PREFIX+'orders-due','-inf',String(Date.now()),'LIMIT','0','5']);
      for(const id of ids) {
        if(Date.now()>deadline)break;
        if(await redis(['GET',PREFIX+'order-done:'+id])){await redis(['ZREM',PREFIX+'orders-due',id]);continue;}
        checked++;
        // Postpone before processing so one broken order cannot starve others,
        // even if this invocation times out. Destination locks handle overlap.
        await redis(['ZADD',PREFIX+'orders-due',String(Date.now()+300000),id]);
        try {
          const result=await reconcilePaidOrder(id,start,{deadline});
          if(result.results?.length && result.results.every(completed)) {
            await redis(['SET',PREFIX+'order-done:'+id,'1','EX','34560000']);
            await redis(['ZREM',PREFIX+'orders-due',id]);recovered++;
          } else {review++;console.error('PAYPRO RECONCILIATION REVIEW',{order_id:id,reason:result.skipped?'not_eligible':'incomplete'});}
        } catch {review++;console.error('PAYPRO RECONCILIATION REVIEW',{order_id:id});}
      }
    }
    const pending=Number(await redis(['ZCARD',PREFIX+'orders-due']));
    const result={ok:true,mode:'active',...queued,discovered,checked,recovered,review,pending};
    console.log('PAYPRO RECOVERY SUMMARY',result);
    return res.status(200).json(result);
  } catch {console.error('PAYPRO RECOVERY FAILED');return res.status(503).json({ok:false,retry_required:true});}
}
