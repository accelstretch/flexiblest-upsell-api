import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as crypto from 'node:crypto';

const source=fs.readFileSync(new URL('../api/paypro-webhook.js',import.meta.url),'utf8')
 .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace(/export default /g,'');
async function snapshot(changes={},authChanges={}) {
 let saved;
 const ctx=vm.createContext({process,Buffer,URL,console,...crypto});
 vm.runInContext(source+'\nthis.persist=persistUpsellChargeResult;this.replaceRedis=f=>{redisCommand=f;};',ctx);
 ctx.replaceRedis(async cmd=>{assert.equal(cmd[0],'EVAL');saved=JSON.parse(cmd[4]);return JSON.stringify({outcome:'saved'});});
 const data={ORDER_ID:'222',PRODUCT_ID:'133573',ORDER_STATUS:'Processed',IPN_TYPE_NAME:'OrderCharged',TEST_MODE:'0',ORDER_TOTAL_AMOUNT:'62.70',ORDER_ITEM_TOTAL_AMOUNT:'57.00',ORDER_CURRENCY_CODE:'EUR',ORDER_PLACED_TIME_UTC:'2026-09-27 18:00:00',CUSTOMER_EMAIL:'fixture@example.com',...changes};
 const authorization={authorized:true,sessionId:'fsess_fixture_123456789',checkoutIntentId:'fchk_fixture_123456789',rootOrderId:'111',session:{openai:{allowed:true,oppref:'opaque-original',captured_at:Date.now()},request_context:{ip_address:'8.8.8.8',user_agent:'fixture'}},...authChanges};
 await ctx.persist(data,authorization);return saved;
}
test('signed upgrade snapshot uses raw charged total/currency/time and original identity',async()=>{
 const s=await snapshot();assert.equal(s.openai_job.payment.ORDER_TOTAL_AMOUNT,'62.70');assert.equal(s.openai_job.payment.ORDER_CURRENCY_CODE,'EUR');assert.equal(s.openai_job.payment.ORDER_PLACED_TIME_UTC,'2026-09-27 18:00:00');assert.equal(s.openai_job.session.paypro_root_order_id,'111');assert.equal(s.openai_job.session.openai.oppref,'opaque-original');assert.equal(s.openai_job.kind,'upsell');
});
test('downsell and manual-fallback confirmations use the same isolated snapshot',async()=>{
 const s=await snapshot({PRODUCT_ID:'133574',ORDER_TOTAL_AMOUNT:'37.00'},{manualFallback:true});assert.equal(s.openai_job.payment.PRODUCT_ID,'133574');assert.equal(s.manualFallback,true);
});
test('test, unconfirmed, unknown consent and root-order reuse never create upgrade jobs',async()=>{
 for(const d of [{TEST_MODE:'1'},{TEST_MODE:''},{ORDER_STATUS:''},{IPN_TYPE_NAME:'OrderRefunded'},{ORDER_ID:'111'}])assert.equal((await snapshot(d)).openai_job,undefined);
 assert.equal((await snapshot({},{session:{openai:{allowed:false}}})).openai_job,undefined);
 assert.equal((await snapshot({},{session:{}})).openai_job,undefined);
});
