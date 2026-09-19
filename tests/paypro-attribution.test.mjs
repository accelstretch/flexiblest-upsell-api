import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
function load(path, names, overrides={}) {
 const code=fs.readFileSync(new URL(path,import.meta.url),'utf8').replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace(/export default /g,'');
 const ctx=vm.createContext({process,URL,Buffer,console,crypto,...crypto,...overrides});
 vm.runInContext(code+'\nthis.exposed={'+names.join(',')+'}',ctx);
 return ctx.exposed;
}
const {buildCometlyEvent}=load('../api/paypro-webhook.js',['buildCometlyEvent']);
const {sanitizeAttribution}=load('../api/paypro-funnel-session.js',['sanitizeAttribution']);
const data={ORDER_PLACED_TIME_UTC:'2026-09-19T14:12:28.000Z',ORDER_ID:'90000001',PRODUCT_ID:'133559',CUSTOMER_EMAIL:'fixture@example.com',ORDER_TOTAL_AMOUNT:'39',ORDER_ITEM_TOTAL_AMOUNT:'39',ORDER_CURRENCY_CODE:'USD',ORDER_ITEM_NAME:'AccelStretch System',PAYMENT_METHOD_NAME:'ApplePay'};
const req={headers:{}};
const base={fs_session_id:'fsess_fixture_123456789',fs_checkout_intent_id:'fchk_fixture_123456789',attribution:{comet_source:'fb',fbclid:'Iw_fixture_click',fbc:'fb.1.123.Iw_fixture_click',fbp:'fb.1.123.456',utm_term:'120249186591430576'}};
const event=(a={},d={},kind='main')=>buildCometlyEvent({...data,...d},req,{...base,attribution:{...base.attribution,...a}},kind);
test('click ID never substitutes for missing ad ID; unknown utm_term is not guessed',()=>{
 const e=event();assert.equal(e.comet_ad_id,'');assert.equal(e.profile_field_10,base.attribution.fbclid);assert.equal(e.profile_field_11,base.attribution.fbc);assert.equal(e.profile_field_12,base.attribution.fbp);
});
test('canonical numeric ad ID preserves precise string and all other order fields',()=>{
 const id='120249186591430576',e=event({comet_ad_id:id});assert.equal(e.comet_ad_id,id);
 const old=event();delete old.comet_ad_id;const rest={...e};delete rest.comet_ad_id;assert.deepEqual(rest,{...old});
 assert.equal(e.amount,39);assert.equal(e.order_id,'90000001');assert.equal(e.idempotency_key,'paypro-90000001-purchase');
});
test('invalid canonical ID cannot mask valid alias or webhook metadata',()=>{
 for(const bad of ['Iw_fixture_click','{{ad.id}}','fb.1.123.click']){
  assert.equal(event({comet_ad_id:bad,ad_id:'120249186591430576'}).comet_ad_id,'120249186591430576');
  assert.equal(event({comet_ad_id:bad},{'x-ad_id':'120249186591430576'}).comet_ad_id,'120249186591430576');
 }
});
test('visitor token and fingerprint survive session sanitization and webhook fallback',()=>{
 const a=sanitizeAttribution({attribution:{comet_token:'token-real',comet_fingerprint:'',fingerprint:'fingerprint-real',_fbc:'fbc-real',_fbp:'fbp-real'}});
 assert.equal(a.comet_fingerprint,'fingerprint-real');assert.equal(a.fbc,'fbc-real');
 const e=event(a);assert.equal(e.comet_token,'token-real');assert.equal(e.fingerprint,'fingerprint-real');
 const fallback=event({}, {'x-comet_token':'webhook-token','x-fingerprint':'webhook-fingerprint'});
 assert.equal(fallback.comet_token,'webhook-token');assert.equal(fallback.fingerprint,'webhook-fingerprint');
});
test('upsell retains event type, amount, deduplication and identifiers',()=>{
 const e=event({comet_ad_id:'120249186591430576',comet_token:'token-real',comet_fingerprint:'fingerprint-real'},{PRODUCT_ID:'133573',ORDER_TOTAL_AMOUNT:'57',ORDER_ITEM_TOTAL_AMOUNT:'57'},'upsell');
 assert.equal(e.event_name,'custom_event_1');assert.equal(e.amount,57);assert.equal(e.idempotency_key,'paypro-90000001-133573');assert.equal(e.fingerprint,'fingerprint-real');
});
for(const page of ['sales','checkout']) test(page+' bridge refreshes delayed identity without reloading payment iframe',async()=>{
 const calls=[],intervals=[],local=new Map(),session=new Map();
 const storage=m=>({getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)});
 class Node {appendChild(child){child.isConnected=true;return child;}}
 const win={location:{origin:'https://flexiblest.com',pathname:'/secure-checkout',search:'?comet_source=fb&comet_ad_id=120249186591430576&fbclid=Iw_fixture_click',href:'https://flexiblest.com/secure-checkout'},localStorage:storage(local),sessionStorage:storage(session),setInterval:fn=>intervals.push(fn),fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return {ok:true,status:200};}};
 const ctx=vm.createContext({window:win,document:{referrer:'',documentElement:{}},Node,URL,URLSearchParams,Promise,Date,console});
 vm.runInContext(fs.readFileSync(new URL('../webflow/'+page+'-bridge.js',import.meta.url),'utf8'),ctx);
 win.cometToken=()=> 'pixel-token';win.cometFingerprint=async()=> 'pixel-fingerprint';
 for(const[k,v]of Object.entries({fs_session_id:'session-test',fs_checkout_intent_id:'intent-test',fs_funnel_access_token:'access-test'}))session.set(k,v);
 intervals[0]();await new Promise(setImmediate);intervals[0]();await new Promise(setImmediate);
 await win.fetch('https://api.flexiblest.io/api/paypro-funnel-session',{body:JSON.stringify({action:'create',attribution:{fbc:'fbc-existing',fbp:'fbp-existing'}})});
 const captured=calls.at(-1).body.attribution;
 assert.equal(captured.comet_token,'pixel-token');assert.equal(captured.comet_fingerprint,'pixel-fingerprint');assert.equal(captured.comet_ad_id,'120249186591430576');assert.equal(captured.fbc,'fbc-existing');
 let src='https://store.payproglobal.com/checkout?products[1][id]=133559&x-long='+ 'a'.repeat(2100),writes=0;
 const frame={nodeType:1,tagName:'IFRAME',isConnected:false,getAttribute:()=>src,setAttribute:(_,v)=>{src=v;writes++;}};
 new Node().appendChild(frame);assert.equal(new URL(src).searchParams.get('x-comet_token'),'pixel-token');assert.equal(new URL(src).searchParams.get('x-comet_fingerprint'),'pixel-fingerprint');assert.equal(new URL(src).searchParams.get('x-long').length,2100);
 new Node().appendChild(frame);assert.equal(writes,1,'never reload mounted payment form');
 assert.ok(calls.some(c=>c.body.action==='save_attribution'));
});
test('generated sanitized fixture is available for payload review',()=>{
 const e=event({comet_ad_id:'120249186591430576',comet_token:'fixture-comet-token',comet_fingerprint:'fixture-fingerprint'});
 fs.mkdirSync(new URL('../docs/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../docs/attribution-test-payload.json',import.meta.url),JSON.stringify(e,null,2)+'\n');
});
test('late attribution endpoint authenticates, preserves identity, and rejects completed sessions',async()=>{
 const commands=[];const token='test_access_token_1234567890';
 const session={fs_checkout_intent_id:'fchk_test_1234567890',access_token_hash:crypto.createHash('sha256').update(token).digest('hex'),status:'created',checkout_email:'existing@example.com'};
 const env={KV_REST_API_URL:'https://redis.test',KV_REST_API_TOKEN:'test'};
 const {handler}=load('../api/paypro-funnel-session.js',['handler'],{process:{env},AbortController,setTimeout,clearTimeout,fetch:async(url,init)=>{
  const cmd=JSON.parse(init.body);commands.push(cmd);return {ok:true,json:async()=>({result:cmd[0]==='GET'?JSON.stringify(session):'OK'})};
 }});
 const call=async(auth=token,extra={})=>{const res={setHeader(){},status(n){this.code=n;return this;},json(x){this.body=x;return this;}};await handler({method:'POST',headers:{origin:'https://flexiblest.com',authorization:'Bearer '+auth},body:{action:'save_attribution',fs_session_id:'fsess_test_1234567890',fs_checkout_intent_id:session.fs_checkout_intent_id,attribution:{comet_token:'late-token',fingerprint:'late-fingerprint'},email:'must-not-overwrite@example.com',...extra}},res);return res;};
 assert.equal((await call('wrong_access_token_123456789')).code,401);assert.equal(commands.filter(c=>c[0]==='EVAL').length,0);
 assert.equal((await call()).code,200);const cmd=commands.at(-1);assert.equal(cmd[0],'EVAL');assert.deepEqual(cmd.slice(6,9),['','','']);assert.equal(JSON.parse(cmd[9]).comet_fingerprint,'late-fingerprint');assert.match(cmd[1],/if ARGV\[3\] ~= "" then/);
 session.status='paid';assert.equal((await call()).code,409);assert.equal(commands.filter(c=>c[0]==='EVAL').length,1);
 session.status='created';assert.equal((await call(token,{action:'save_checkout_email',email:''})).code,400);
});
