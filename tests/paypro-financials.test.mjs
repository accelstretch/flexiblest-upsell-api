import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {snapshot,planSnapshot,processFinancials,SAVE_LOCKED,UNLOCK,withFinancials,validSignature,cents} from '../lib/paypro-financials.js';
import endpoint from '../api/paypro-financials.js';
const order=(net=38.07,refunded=0,status=5)=>({orderId:100001,isTestMode:false,balanceCurrencyCode:'USD',orderStatusId:status,createdAt:'2026-09-19T10:00:00.000',customer:{email:'test@example.com'},balanceVendorTotalAmount:net,balanceRefundedAmount:refunded,orderItems:[{productId:133559,balanceVendorAmount:net}]});
const notification={ORDER_ID:'100001',PRODUCT_ID:'133559',IPN_TYPE_NAME:'OrderCharged',TEST_MODE:'0'};
const now='2026-09-19T11:00:00.000Z';
function memory(){const data=new Map();return {data,redis:async([op,...a])=>{
 if(op==='GET')return data.get(a[0])??null;
 if(op==='SET'){if(a.includes('NX')&&data.has(a[0]))return null;data.set(a[0],a[1]);return 'OK';}
 if(op==='EVAL'&&a[0]===SAVE_LOCKED){const[,,lock,key,token,val]=a;if(data.get(lock)!==token)return 0;data.set(key,val);return 1;}
 if(op==='EVAL'&&a[0]===UNLOCK){const[,,lock,token]=a;if(data.get(lock)!==token)return 0;data.delete(lock);return 1;}
 throw Error('Unexpected command');
}};}
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(x){this.body=x;return this;}};}
test('API values verified against actual main, bump and refunded order reports',()=>{
 for(const[net,refund,status]of[[38.07,0,5],[-2.21,23.20,3],[-3.53,45.60,3]])assert.equal(snapshot(order(net,refund,status),100001).net,Math.round(net*100));
});
test('equal repeated partial refunds reduce earnings twice, duplicate snapshots do not',()=>{
 let state={};const values=[];
 for(const[net,r]of[[26.79,0],[16.79,10],[6.79,20],[6.79,20],[-2.21,29]]){const p=planSnapshot(snapshot(order(net,r),100001),state,now);state=p.state;values.push(...p.entries.map(e=>e.amount*(e.event_name==='custom_event_2'?1:-1)));}
 assert.deepEqual(values,[26.79,-10,-10,-9]);assert.equal(Math.round(values.reduce((a,b)=>a+b,0)*100),-221);
});
test('won dispute uses actual recovered balance and retains unrecovered fee',()=>{
 let state={};const events=[];for(const net of [26.79,-17.21,11.79]){const p=planSnapshot(snapshot(order(net),100001),state,now);state=p.state;events.push(...p.entries);}
 assert.deepEqual(events.map(e=>e.amount),[26.79,44,29]);assert.equal(state.net,1179);assert.ok(events.every(e=>e.do_not_capi===true));
});
test('snapshot rejects unverified, mixed-product, wrong currency and inconsistent balances',()=>{
 for(const change of [{isTestMode:true},{balanceCurrencyCode:'EUR'},{orderId:5},{balanceVendorTotalAmount:undefined},{orderItems:[{productId:133610,balanceVendorAmount:38.07}]},{balanceVendorTotalAmount:5}])assert.throws(()=>snapshot({...order(),...change},100001));
 for(const v of ['',null,undefined,'abc'])assert.throws(()=>cents(v));
});
test('pending deliveries retry identical keys and timestamps before newer snapshot',async()=>{
 const m=memory(),events=[];const deps={redis:m.redis,token:'a',now:()=>now,getOrder:async()=>order(),send:async e=>{events.push(e);throw Error('timeout');}};
 await assert.rejects(processFinancials(notification,deps));
 await processFinancials(notification,{...deps,token:'b',getOrder:async()=>order(28.07,10),send:async e=>events.push(e)});
 assert.deepEqual(events[0],events[1]);assert.equal(events[2].amount,10);assert.notEqual(events[2].idempotency_key,events[1].idempotency_key);
});
test('concurrent notifications serialize and duplicate bump notification adds no money',async()=>{
 const m=memory();let release,started;const waiting=new Promise(r=>release=r),ready=new Promise(r=>started=r);const deps={redis:m.redis,getOrder:async()=>order(),token:'a',send:async()=>{started();await waiting;}};
 const a=processFinancials(notification,deps);await ready;await assert.rejects(processFinancials(notification,{...deps,token:'b'}),/busy/);release();await a;
 assert.equal((await processFinancials({...notification,PRODUCT_ID:'133565'},{...deps,token:'c',send:async()=>assert.fail()})).entries,0);
});
test('historical orders and test notifications do not create financial events',async()=>{
 const m=memory(),deps={redis:m.redis,token:'a',getOrder:async()=>({...order(),createdAt:'2026-09-01T00:00:00'}),send:async()=>assert.fail()};
 assert.equal((await processFinancials(notification,deps)).skipped,'before_reporting_start');assert.equal((await processFinancials({...notification,TEST_MODE:'1'},deps)).skipped,'unrelated_or_test');
});
test('original handler response and headers remain intact; rejected purchases never invoke reporting',async()=>{
 for(const code of [200,401,405,503]){const res=response();let called=false;await withFinancials(async(req,r)=>{r.setHeader('X-Test','yes');return r.status(code).json({original:true});},{method:'POST',body:{}},res,async()=>called=true);assert.equal(called,code===200);assert.equal(res.code,code);assert.deepEqual(res.body,{original:true});assert.equal(res.headers['X-Test'],'yes');}
});
test('financial failures occur after fulfillment and request a PayPro retry',async()=>{
 const res=response();let fulfilled=false;await withFinancials(async(req,r)=>{fulfilled=true;r.status(200).json({ok:true});},{method:'POST',body:{}},res,async()=>{assert.equal(fulfilled,true);throw Error('ledger unavailable');});assert.equal(res.code,503);assert.equal(res.body.financial_retry_required,true);
});
test('unauthenticated diagnostic endpoint cannot read PayPro or Cometly',async()=>{
 process.env.PAYPRO_VALIDATION_KEY='test-key';const old=globalThis.fetch;globalThis.fetch=async()=>assert.fail();try{const res=response();await endpoint({method:'POST',body:{}},res);assert.equal(res.code,401);}finally{globalThis.fetch=old;}
});
test('PayPro signatures verified before reporting and cents preserve USD arithmetic',()=>{
 const d={...notification,ORDER_STATUS:'Processed',ORDER_TOTAL_AMOUNT:'39',CUSTOMER_EMAIL:'test@example.com'};
 const key='test-key';d.SIGNATURE=createHash('sha256').update(d.ORDER_ID+d.ORDER_STATUS+d.ORDER_TOTAL_AMOUNT+d.CUSTOMER_EMAIL+key+d.TEST_MODE+d.IPN_TYPE_NAME).digest('hex');assert.equal(validSignature(d,key),true);assert.equal(validSignature({...d,ORDER_ID:'2'},key),false);
});
