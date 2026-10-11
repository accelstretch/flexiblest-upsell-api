import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function visit(page,stored,query='',cookie=''){
 const map=new Map([['fs_attribution_data',JSON.stringify(stored)]]),calls=[];
 class Node{appendChild(c){c.isConnected=true;return c;}}
 const win={location:{origin:'https://flexiblest.com',pathname:'/secure-checkout',href:'https://flexiblest.com/secure-checkout'+query,search:query},localStorage:{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)},sessionStorage:{getItem:()=>null},setInterval(){},fetch:async(u,i)=>{calls.push(JSON.parse(i.body));return{ok:true}}};
 vm.runInNewContext(fs.readFileSync(new URL('../webflow/'+page+'-bridge.js',import.meta.url),'utf8'),{window:win,document:{cookie,referrer:'',documentElement:{}},Node,URL,URLSearchParams,Date,Promise,console});
 return {get:()=>JSON.parse(JSON.stringify(win.fsCaptureCoherentAttribution())),win,calls};
}
const paid={fs_touch_id:'old-touch',fs_touch_at:new Date(Date.now()-3600000).toISOString(),comet_ad_id:'123',ad_id:'123',comet_source:'fb',campaign_id:'456',fbclid:'old',fbc:'fb.1.'+(Date.now()-3600000)+'.old',fbp:'browser',comet_token:'visitor'};
for(const page of ['sales','checkout']){
 test(page+': new FB click with no ad does not inherit previous paid ad',()=>{
  const v=visit(page,paid,'?fbclid=new','_fbc='+paid.fbc),a=v.get();
  assert.equal(a.fbclid,'new');assert.equal(a.comet_ad_id,'');assert.equal(a.campaign_id,'');assert.equal(JSON.parse(a.fs_previous_paid_touch).comet_ad_id,'123');assert.equal(a.comet_token,'visitor');assert.equal(v.get().fs_touch_id,a.fs_touch_id);
 });
 test(page+': Google visit cannot regain stale Facebook cookie on second capture',()=>{
  const v=visit(page,paid,'?gclid=google&comet_source=google','_fbc='+paid.fbc);for(let i=0;i<3;i++){const a=v.get();assert.equal(a.gclid,'google');assert.equal(a.fbclid,'');assert.equal(a.comet_ad_id,'');}
 });
 test(page+': internal/organic return preserves legitimate earlier paid touch',()=>{
  const a=visit(page,paid,'','_fbc='+paid.fbc).get();assert.equal(a.comet_ad_id,'123');assert.equal(a.fbclid,'old');assert.equal(a.fs_touch_id,'old-touch');
 });
 test(page+': new cookie starts separate touch and expires stale metadata',()=>{
  const a=visit(page,paid,'','_fbc=fb.1.'+Date.now()+'.new').get();assert.equal(a.fbclid,'new');assert.equal(a.comet_ad_id,'');
  const old={...paid,fs_touch_at:new Date(Date.now()-31*86400000).toISOString()};const b=visit(page,old,'','_fbc='+paid.fbc).get();assert.equal(b.comet_ad_id,'');assert.equal(b.fbclid,'');
 });
 test(page+': legacy request body cannot reintroduce stale ad after capture',async()=>{
  const v=visit(page,paid,'?fbclid=new');await v.win.fetch('https://api.flexiblest.io/api/paypro-funnel-session',{body:JSON.stringify({action:'create',attribution:{comet_ad_id:'123',campaign_id:'456'}})});
  assert.equal(v.calls[0].attribution.comet_ad_id,'');assert.equal(v.calls[0].attribution.campaign_id,'');
 });
}
