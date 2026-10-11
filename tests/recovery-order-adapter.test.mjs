import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source=fs.readFileSync(new URL('../api/paypro-webhook.js',import.meta.url),'utf8');
function adapter(){
 const delivered=[];
 const ctx=vm.createContext({process:{env:{PAYPRO_VENDOR_ACCOUNT_ID:'123456'}},Date,URL,Buffer,console,crypto,...crypto,
 responseBuffer:()=>({code:200,body:null}),getOrder:()=>{throw Error('must inject read')},
 withFinancials:async(_,req,res)=>{delivered.push(req.body);res.body={ok:true,secure_session_verified:true,sent_to_cometly:true,kajabi_access_updated:true};}});
 vm.runInContext(source.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace(/export default /g,'').replace(/export (?=async function|function|const)/g,'')+'\nthis.reconcile=reconcilePaidOrder',ctx);
 return {run:ctx.reconcile,delivered};
}
const now=Date.parse('2026-10-11T04:00:00Z'), start=now-3600000;
const fields={'x-fs_session_id':'fixture-session','x-fs_checkout_intent_id':'fixture-intent','x-offer_step':'main'};
const order={orderId:90000001,createdAt:'2026-10-11T03:30:00',isTestMode:false,orderStatusId:5,billingRefundedAmount:0,billingTotalPrice:41,billingTotalTaxes:0,billingCurrencyCode:'USD',customer:{email:'fixture@example.test'},customFields:fields,
 orderItems:[{orderId:90000001,orderItemId:90000003,productId:133565,vendorAccountId:123456},{orderId:90000001,orderItemId:90000002,productId:133559,vendorAccountId:123456}]};
const options=o=>({readOrder:async()=>o,now:()=>now});
for(const shape of ['dictionary','array'])test('validated '+shape+' preserves gross total/time, main before bump, and never fabricates signature',async()=>{
 const a=adapter(),o=structuredClone(order);if(shape==='array')o.customFields=Object.entries(fields).map(([customFieldKey,customFieldValue])=>({customFieldKey,customFieldValue}));
 const r=await a.run('90000001',start,options(o));assert.equal(r.results.length,2);
 assert.deepEqual(a.delivered.map(d=>d.PRODUCT_ID),['133559','133565']);
 for(const d of a.delivered){assert.equal(d.ORDER_TOTAL_AMOUNT,'41');assert.equal(d.ORDER_PLACED_TIME_UTC,'2026-10-11T03:30:00.000Z');assert.equal(d['x-fs_session_id'],'fixture-session');assert.equal(Object.hasOwn(d,'SIGNATURE'),false);}
});
test('audit mode reads and validates only; no destination calls',async()=>{const a=adapter();assert.equal((await a.run('90000001',start,{...options(order),audit:true})).audit,true);assert.equal(a.delivered.length,0);});
test('old manually fulfilled, test, unpaid, refunded and too-recent orders cause no delivery',async()=>{
 for(const changes of [{createdAt:'2026-10-10T03:30:00'},{isTestMode:true},{orderStatusId:1},{billingRefundedAmount:12},{createdAt:'2026-10-11T03:59:59'}]){
  const a=adapter();assert.equal((await a.run('90000001',start,options({...order,...changes}))).skipped,true);assert.equal(a.delivered.length,0);
 }
});
test('mismatched order/vendor, mixed product, duplicate/missing metadata fail closed',async()=>{
 for(const changes of [{orderId:90000004},{orderItems:[{...order.orderItems[0],vendorAccountId:999}]},{orderItems:[{...order.orderItems[0],productId:999}]},{customFields:{}},{customFields:[{customFieldKey:'x-a',customFieldValue:'one'},{customFieldKey:'x-a',customFieldValue:'two'}]}]){
  const a=adapter();await assert.rejects(a.run('90000001',start,options({...order,...changes})));assert.equal(a.delivered.length,0);
 }
});
