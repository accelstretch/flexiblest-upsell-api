import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
export const START = '2026-09-18T19:00:00Z';
export const PRODUCTS = new Set(['133559','133565','133569','133573','133574']);
export const EVENTS = { credit:'custom_event_2', debit:'custom_event_3' };
const value = x => x == null ? '' : String(x).trim();
export function parseBody(body) {
  if (Buffer.isBuffer(body)) body=body.toString('utf8');
  if (typeof body==='string') return body.trim().startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new Error('Invalid body');
  return body;
}
export function validSignature(data,key) {
  if(!key) throw new Error('Missing validation key');
  const received=value(data.SIGNATURE).toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(received)) return false;
  const input=['ORDER_ID','ORDER_STATUS','ORDER_TOTAL_AMOUNT','CUSTOMER_EMAIL'].map(k=>value(data[k])).join('')+key+value(data.TEST_MODE)+value(data.IPN_TYPE_NAME);
  return timingSafeEqual(Buffer.from(received),Buffer.from(createHash('sha256').update(input).digest('hex')));
}
export function cents(x) {
  if(!/^-?\d+(?:\.\d+)?$/.test(value(x)) || Math.abs(Number(x))>1e7) throw new Error('Missing/invalid financial amount');
  return Math.round(Number(x)*100);
}
export function relevant(data) {
  return !['1','true','yes'].includes(value(data.TEST_MODE).toLowerCase()) && PRODUCTS.has(value(data.PRODUCT_ID)) && ['ordercharged','orderrefunded','orderpartiallyrefunded','orderchargedback','orderchargedbackwon'].includes(value(data.IPN_TYPE_NAME).toLowerCase());
}
export function snapshot(order,expectedId) {
  if(value(order.orderId)!==value(expectedId)) throw new Error('Order mismatch');
  if(order.isTestMode!==false) throw new Error('Not a verified live order');
  if(order.balanceCurrencyCode!=='USD') throw new Error('Expected USD balance');
  if(![3,4,5].includes(order.orderStatusId)) throw new Error('Order not financially settled');
  if(!order.orderItems?.length || order.orderItems.some(i=>!PRODUCTS.has(value(i.productId)))) throw new Error('Mixed or unrelated order');
  const net=cents(order.balanceVendorTotalAmount);
  if(order.orderItems.reduce((n,i)=>n+cents(i.balanceVendorAmount),0)!==net) throw new Error('Item totals differ from order earnings');
  const email=value(order.customer?.email).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Missing customer identity');
  let raw=value(order.createdAt);
  if(raw&&!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw+='Z';
  const created=new Date(raw);
  if(!Number.isFinite(created.getTime())) throw new Error('Invalid order date');
  return {order:value(order.orderId),net,email,created:created.toISOString(),refunded:cents(order.balanceRefundedAmount),status:order.orderStatusId};
}
export function planSnapshot(current,previous={},now=new Date().toISOString()) {
  const delta=current.net-(previous.net??0), revision=(previous.revision??0)+1;
  const state={net:current.net,revision,refunded:current.refunded,checkedAt:now};
  if(delta===0) return {state:{...state,revision:previous.revision??0},entries:[]};
  const id=`paypro-net-v2-${current.order}-${revision}`;
  return {state,entries:[{
    event_name:EVENTS[delta>0?'credit':'debit'],email:current.email,amount:Math.abs(delta)/100,
    event_time:previous.net===undefined && current.refunded===0 && current.status===5 ? current.created : now,
    order_id:id,idempotency_key:id,order_name:`PayPro net earnings change | order ${current.order}`,
    do_not_capi:true
  }]};
}
export const SAVE_LOCKED="if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2]) return 1";
export const UNLOCK="if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
export async function processFinancials(data,{redis,send,getOrder,now=()=>new Date().toISOString(),token=randomUUID()}) {
  if(!relevant(data)) return {skipped:'unrelated_or_test'};
  const order=value(data.ORDER_ID);
  if(!/^\d+$/.test(order)) throw new Error('Invalid order id');
  const key=`paypro:net:v2:${order}`,lock=`${key}:lock`;
  if(await redis(['SET',lock,token,'NX','EX','120'])!=='OK') throw new Error('Financial order busy');
  const save=async state=>{if(await redis(['EVAL',SAVE_LOCKED,'2',lock,key,token,JSON.stringify(state)])!==1) throw new Error('Financial lease expired');};
  try {
    let state=JSON.parse(await redis(['GET',key])||'{}');
    const flush=async()=>{
      if(!state.pending) return;
      for(const event of state.pending.entries) await send(event);
      state=state.pending.next; await save(state);
    };
    await flush();
    const current=snapshot(await getOrder(order),order);
    if(current.created<new Date(START).toISOString()) return {skipped:'before_reporting_start'};
    // A full-refund notification must not read an older processed snapshot.
    if(value(data.IPN_TYPE_NAME).toLowerCase()==='orderrefunded' && current.status!==3) throw new Error('Refund snapshot not settled');
    if(value(data.IPN_TYPE_NAME).toLowerCase()==='orderpartiallyrefunded' && current.refunded===0) throw new Error('Partial refund snapshot not settled');
    const next=planSnapshot(current,state,now());
    if(next.entries.length){state.pending={entries:next.entries,next:next.state};await save(state);await flush();}
    else await save(next.state);
    return {accepted:true,entries:next.entries.length,net:current.net/100};
  } finally {await redis(['EVAL',UNLOCK,'1',lock,token]);}
}
export async function redis(command) {
  const url=process.env.KV_REST_API_URL,token=process.env.KV_REST_API_TOKEN;
  if(!url||!token) throw new Error('Missing ledger configuration');
  const res=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
  const result=await res.json();if(!res.ok||result.error) throw new Error('Ledger unavailable');return result.result;
}
export async function getOrder(orderId) {
  const vendorAccountId=Number(process.env.PAYPRO_VENDOR_ACCOUNT_ID),apiSecretKey=process.env.PAYPRO_API_SECRET_KEY;
  if(!vendorAccountId||!apiSecretKey) throw new Error('Missing PayPro API configuration');
  const res=await fetch('https://store.payproglobal.com/api/Orders/GetOrderDetails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vendorAccountId,apiSecretKey,orderId:Number(orderId),dateFormat:'a'}),signal:AbortSignal.timeout(10000)});
  const result=await res.json();if(!res.ok||!result.isSuccess||!result.response) throw new Error('PayPro order read failed');return result.response;
}
export async function send(event) {
  const token=process.env.COMETLY_API_KEY;if(!token) throw new Error('Missing Cometly configuration');
  const res=await fetch('https://app.cometly.com/public-api/v1/events/track',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
  if(!res.ok) throw new Error(`Cometly rejected financial event (${res.status})`);
}
export const liveFinancials=data=>processFinancials(data,{redis,send,getOrder});
// Preserve original fulfillment/purchase behavior. Only after that succeeds,
// reconcile finances. A financial failure requests an IPN retry; the existing
// purchase and fulfillment paths retain their own idempotency protection.
export async function withFinancials(original,req,res,reconcile=liveFinancials) {
  const buffered={code:200,body:undefined,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(x){this.body=x;return this;}};
  await original(req,buffered);
  for(const [k,v] of Object.entries(buffered.headers)) res.setHeader(k,v);
  if(buffered.code===200 && req.method==='POST') {
    try {await reconcile(parseBody(req.body));}
    catch(error){console.error('PAYPRO FINANCIAL RECONCILIATION REQUIRED',{reason:error.message});return res.status(503).json({ok:false,financial_retry_required:true});}
  }
  return res.status(buffered.code).json(buffered.body);
}
