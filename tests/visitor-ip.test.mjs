import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {normalizePublicIp, getBrowserRequestIp, selectVisitorIp} from '../lib/visitor-ip.js';

const blocked = [
  '0.0.0.0','0.255.255.255','10.0.0.1','100.64.0.1','100.127.255.255',
  '127.0.0.1','169.254.1.1','172.16.0.1','172.31.255.255','192.0.0.8',
  '192.0.0.170','192.0.2.1','192.88.99.2','192.168.0.1','198.18.0.1',
  '198.19.255.255','198.51.100.20','203.0.113.1','224.0.0.1','239.255.255.255',
  '240.0.0.1','255.255.255.255','::','::1','fc00::1','fdff::1','fe80::1',
  'fec0::1','ff02::1','2001:db8::1','2001:2::1','2001:10::1','3fff::1',
  '100::1','100:0:0:1::1','5f00::1','4000::1','2002:7f00:1::1',
  '64:ff9b:1::1','::ffff:127.0.0.1','::ffff:a00:1','::ffff:192.0.2.1'
];
test('reject non-public IPv4/IPv6 and mapped private addresses',()=>{
  for(const ip of blocked) assert.equal(normalizePublicIp(ip),'',ip);
});
test('retain public boundaries and normalize public IPv6/mapped IPv4',()=>{
  for(const ip of ['8.8.8.8','1.1.1.1','100.63.255.255','100.128.0.0','172.15.255.255','172.32.0.0','192.0.0.9','192.0.0.10','198.17.255.255','198.20.0.0','223.255.255.255','2001:4860:4860::8888','2001:1::3','2001:3::1','2001:200::1','3ffe::1']) assert.equal(normalizePublicIp(ip),ip,ip);
  assert.equal(normalizePublicIp(' 2606:4700:4700:0000:0000:0000:0000:1111 '),'2606:4700:4700::1111');
  assert.equal(normalizePublicIp('::ffff:8.8.8.8'),'8.8.8.8');
  assert.equal(normalizePublicIp('0:0:0:0:0:FFFF:808:808'),'8.8.8.8');
});
test('reject malformed address values without throwing or coercion',()=>{
  for(const ip of [undefined,null,123,{},['8.8.8.8'],'','unknown','999.1.1.1','8.8.8.8:443','[2606:4700::1]','https://8.8.8.8','8.8.8.8, 1.1.1.1','2606:4700::1%eth0','8.8.8.\n8','008.8.8.8']) assert.equal(normalizePublicIp(ip),'');
});
test('trust platform header precedence and never fall through malformed trusted values',()=>{
  assert.deepEqual(getBrowserRequestIp({'x-vercel-forwarded-for':'8.8.8.8','x-forwarded-for':'1.1.1.1','cf-connecting-ip':'9.9.9.9'}),{ip:'8.8.8.8',source:'x-vercel-forwarded-for'});
  for(const invalid of ['unknown','127.0.0.1','8.8.8.8, 1.1.1.1','',['8.8.8.8']]) assert.deepEqual(getBrowserRequestIp({'x-vercel-forwarded-for':invalid,'x-forwarded-for':'1.1.1.1'}),{ip:'',source:'none'});
  assert.equal(getBrowserRequestIp({'x-forwarded-for':'1.1.1.1'}).source,'x-forwarded-for');
  assert.equal(getBrowserRequestIp({'x-real-ip':'1.1.1.1'}).source,'x-real-ip');
  assert.equal(getBrowserRequestIp({'cf-connecting-ip':'1.1.1.1'}).ip,'');
});
function load(path,names){
  const raw=fs.readFileSync(new URL(path,import.meta.url),'utf8');
  const ctx=vm.createContext({process:{env:{}},URL,Buffer,console,crypto,...crypto,selectVisitorIp,getBrowserRequestIp});
  vm.runInContext(raw.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace(/export default /g,'')+'\nthis.exposed={'+names.join(',')+'}',ctx);
  return ctx.exposed;
}
const {buildCometlyEvent}=load('../api/paypro-webhook.js',['buildCometlyEvent']);
const {getRequestContext}=load('../api/paypro-funnel-session.js',['getRequestContext']);
const data={CUSTOMER_EMAIL:'fixture@example.test',ORDER_ID:'90000001',PRODUCT_ID:'133559',ORDER_TOTAL_AMOUNT:'29'};
const session={request_context:{ip_address:'8.8.8.8',user_agent:'Browser/fixture'},attribution:{comet_token:'fixture-token',comet_fingerprint:'fixture-fingerprint'}};
const req={headers:{'x-vercel-forwarded-for':'1.1.1.1','user-agent':'PayProServer/fixture'}};
test('actual main/upsell builders fall back to browser IP when PayPro IP is unsuitable',()=>{
  for(const kind of ['main','upsell']) for(const ip of blocked){
    const event=buildCometlyEvent({...data,CUSTOMER_IP:ip},req,session,kind);
    assert.equal(event.ip,'8.8.8.8',ip);
    assert.equal(event.user_agent,'Browser/fixture');
    assert.equal(event.fingerprint,'fixture-fingerprint');
    assert.equal(event.amount,29);
    assert.equal(event.idempotency_key,kind==='main'?'paypro-90000001-purchase':'paypro-90000001-133559');
  }
  assert.equal(buildCometlyEvent({...data,CUSTOMER_IP:'::ffff:1.1.1.1'},req,session,'main').ip,'1.1.1.1');
  assert.equal(selectVisitorIp('127.0.0.1','8.8.8.8').source,'browser_session');
});
test('no usable visitor IP omits identity group, retaining token/email and never using webhook headers',()=>{
  const event=buildCometlyEvent({...data,CUSTOMER_IP:'10.0.0.1'},req,{...session,request_context:{ip_address:'::1',user_agent:'Browser/fixture'}},'main');
  for(const key of ['ip','fingerprint','user_agent']) assert.equal(Object.hasOwn(event,key),false);
  assert.equal(event.comet_token,'fixture-token');
  assert.equal(event.email,'fixture@example.test');
});
test('session capture stores normalized IP provenance with the browser UA',()=>{
  const c=getRequestContext({headers:{'x-vercel-forwarded-for':'::ffff:8.8.8.8','user-agent':'Browser/fixture'}},{});
  assert.equal(c.ip_address,'8.8.8.8'); assert.equal(c.ip_source,'x-vercel-forwarded-for'); assert.equal(c.user_agent,'Browser/fixture');
  assert.equal(getRequestContext({headers:{'x-vercel-forwarded-for':'127.0.0.1'}},{}).ip_address,'');
});
