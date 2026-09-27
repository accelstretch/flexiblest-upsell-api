import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildOpenAIEvent, minorUnits, eventTime, sanitizeOpenAI, sendOpenAI, DAY } from '../lib/openai-conversions.js';
import handler from '../api/openai-conversions-worker.js';
const now=Date.parse('2026-09-27T18:00:00Z');
const record=()=>({payment:{ORDER_ID:'12345',PRODUCT_ID:'133559',ORDER_STATUS:'Processed',IPN_TYPE_NAME:'OrderCharged',TEST_MODE:'0',ORDER_TOTAL_AMOUNT:'60.00',ORDER_CURRENCY_CODE:'USD',ORDER_PLACED_TIME_UTC:'2026-09-27 17:00:00',CUSTOMER_EMAIL:' Person@Example.com '},session:{paypro_root_order_id:'12345',openai:{allowed:true,oppref:'opaque_abc-==',captured_at:now-2*DAY,obref:'browser-ref'},request_context:{ip_address:'8.8.8.8',user_agent:'Browser fixture'}}});
test('paid main order uses actual total including bumps and stable ID with hashed matching',()=>{
 const e=buildOpenAIEvent(record(),now);assert.equal(e.id,'paypro-12345-purchase');assert.equal(e.timestamp_ms,now-3600000);assert.deepEqual(e.data,{type:'contents',amount:6000,currency:'USD'});assert.equal(e.oppref,'opaque_abc-==');assert.equal(e.user.obref,'browser-ref');assert.match(e.user.emails_sha256[0],/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(e).includes('Person@'));assert.equal(e.user.ip_address,'8.8.8.8');
});
for(const [field,value] of [['TEST_MODE','1'],['TEST_MODE',''],['ORDER_STATUS',''],['ORDER_STATUS','Waiting'],['IPN_TYPE_NAME','OrderRefunded'],['IPN_TYPE_NAME',''],['PRODUCT_ID','133565'],['PRODUCT_ID','133573'],['ORDER_ID','99999']]) test('reject ineligible '+field+'='+value,()=>{const r=record();r.payment[field]=value;assert.equal(buildOpenAIEvent(r,now),null);});
test('denied and unknown permission suppress all matching and purchases',()=>{for(const value of [false,undefined]){const r=record();r.session.openai.allowed=value;assert.equal(buildOpenAIEvent(r,now),null);}});
test('amount conversion supports minor-unit exponents without float rounding or currency guessing',()=>{
 assert.equal(minorUnits('29.00','USD'),2900);assert.equal(minorUnits('100','JPY'),100);assert.equal(minorUnits('1.234','KWD'),1234);
 for(const [v,c] of [['0','USD'],['-1','USD'],['NaN','USD'],['1.001','USD'],['29','BAD'],['29','']])assert.throws(()=>minorUnits(v,c));
});
test('timestamps require valid UTC, never fallback to send time',()=>{assert.equal(eventTime('2026-09-27 17:00:00'),now-3600000);for(const v of ['', 'yesterday','2026-02-31T12:00:00','2026-09-27T17:00:00-07:00'])assert.throws(()=>eventTime(v));const r=record();r.payment.ORDER_PLACED_TIME_UTC='2026-09-19T17:00:00Z';assert.throws(()=>buildOpenAIEvent(r,now));});
test('opaque matching retained exactly, stale click discarded, denied clears identifiers',()=>{assert.deepEqual(sanitizeOpenAI({allowed:false,oppref:'x'},now),{allowed:false});assert.equal(sanitizeOpenAI({allowed:true,oppref:'abc==',captured_at:now},now).oppref,'abc==');assert.equal(sanitizeOpenAI({allowed:true,oppref:'abc',captured_at:now-31*DAY},now).oppref,undefined);assert.equal(sanitizeOpenAI({allowed:true,oppref:' abc ',captured_at:now},now).oppref,undefined);});
test('no private visitor IP and no synthesized external customer ID',()=>{const r=record();r.session.request_context.ip_address='127.0.0.1';const e=buildOpenAIEvent(r,now);assert.equal(e.user.ip_address,undefined);assert.equal(e.user.external_ids_sha256,undefined);});
test('validation request explicitly cannot save revenue',async()=>{let sent;const e=buildOpenAIEvent(record(),now);await sendOpenAI(e,{env:{OPENAI_ADS_PIXEL_ID:'pixel',OPENAI_CONVERSIONS_API_KEY:'fixture'},validateOnly:true,fetcher:async(url,opts)=>{sent={url,body:JSON.parse(opts.body)};return{ok:true,status:200};}});assert.equal(sent.body.validate_only,true);assert.equal(sent.body.events[0].id,e.id);});
test('worker rejects missing/wrong credentials before any storage/network',async()=>{delete process.env.CRON_SECRET;const response=()=>({setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});let res=response();await handler({method:'GET',headers:{}},res);assert.equal(res.code,401);process.env.CRON_SECRET='test';res=response();await handler({method:'POST',headers:{authorization:'Bearer test'}},res);assert.equal(res.code,405);delete process.env.CRON_SECRET;});
function browser({search='?oppref=opaque%2Bvalue%3D',cookies='',stored=new Map(),blocked=false}={}) {
 const listeners={};const storage={getItem:k=>{if(blocked)throw Error();return stored.get(k)||null;},setItem:(k,v)=>{if(blocked)throw Error();stored.set(k,v);},removeItem:k=>stored.delete(k)};
 const window={location:{search,origin:'https://flexiblest.com',href:'https://flexiblest.com/accelstretch'+search},localStorage:storage};const document={cookie:cookies,addEventListener:(n,f)=>listeners[n]=f};
 vm.runInNewContext(fs.readFileSync(new URL('../webflow/openai-attribution.js',import.meta.url),'utf8'),{window,document,URL,URLSearchParams,Date,console});return{window,document,stored,listeners};
}
test('landing and checkout preserve original opaque reference without double decoding',()=>{const a=browser(),b=browser({search:'',stored:a.stored});assert.equal(b.window.fsGetOpenAIAttribution().oppref,'opaque+value=');});
test('blocked storage supports first-party click handoff, never decorates third-party links',()=>{const a=browser({blocked:true}),anchor={href:'https://flexiblest.com/secure-checkout?utm_source=fb'};a.listeners.click({target:{closest:()=>anchor}});assert.equal(new URL(anchor.href).searchParams.get('oppref'),'opaque+value=');assert.equal(new URL(anchor.href).searchParams.get('utm_source'),'fb');anchor.href='https://store.payproglobal.com/checkout';a.listeners.click({target:{closest:()=>anchor}});assert.equal(anchor.href,'https://store.payproglobal.com/checkout');});
test('late cookie enters matching; explicit withdrawal removes stored click',()=>{const a=browser();a.document.cookie='__obref=late';assert.equal(a.window.fsGetOpenAIAttribution().obref,'late');a.stored.set('oaiq_consent','false');assert.equal(a.window.fsGetOpenAIAttribution().allowed,false);assert.equal(a.stored.has('fs_openai_attribution_v1'),false);});
test('new URL click wins over stale pixel cookie and no new timer/library/event is introduced',()=>{const a=browser({cookies:'__oppref=old'});assert.equal(a.window.fsGetOpenAIAttribution().oppref,'opaque+value=');const source=fs.readFileSync(new URL('../webflow/openai-attribution.js',import.meta.url),'utf8');assert.ok(!/setInterval|fetch\(|createElement|oaiq\(/.test(source));});

test('protected diagnostic forces validate_only and sends no customer information',async()=>{
 const oldFetch=globalThis.fetch, before={...process.env};let request;
 try {
  process.env.CRON_SECRET='fixture';process.env.OPENAI_CONVERSIONS_API_KEY='fixture';process.env.OPENAI_ADS_PIXEL_ID='fixture';
  globalThis.fetch=async(url,options)=>{request=JSON.parse(options.body);return{ok:true,status:200};};
  const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await handler({method:'GET',headers:{authorization:'Bearer fixture'},query:{validate_only:'1'}},res);
  assert.equal(res.code,200);assert.equal(request.validate_only,true);assert.equal(request.events[0].user,undefined);assert.equal(res.body.validation_only,true);
  await handler({method:'GET',headers:{authorization:'Bearer fixturé'},query:{}},res);assert.equal(res.code,401);
 }finally{globalThis.fetch=oldFetch;for(const k of ['CRON_SECRET','OPENAI_CONVERSIONS_API_KEY','OPENAI_ADS_PIXEL_ID']){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}}
});
