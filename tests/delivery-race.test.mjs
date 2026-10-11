import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source=fs.readFileSync(new URL('../api/paypro-webhook.js',import.meta.url),'utf8').replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace(/export default /g,'').replace(/export (?=async function|function|const)/g,'');
for(const destination of ['Kajabi','Cometly'])test(destination+' completion racing lock acquisition cannot send again',async()=>{
 let reads=0,unlocks=0,sends=0;
 const context=vm.createContext({process:{env:{COMETLY_API_KEY:'test'}},console,Buffer,crypto,...crypto,
 stubRedis:async cmd=>{if(cmd[0]==='GET')return ++reads===1?null:JSON.stringify(destination==='Kajabi'?{delivered:true}:{sent:true});if(cmd[0]==='SET')return 'OK';throw Error('unexpected Redis operation');},
 stubUnlock:async()=>{unlocks++;},fetch:async()=>{sends++;throw Error('must not send');}});
 vm.runInContext(source+'\nredisCommand=stubRedis;releaseLock=stubUnlock;this.run='+ (destination==='Kajabi'?'processKajabiAccess':'sendCometlyEvent'),context);
 const input=destination==='Kajabi'?{ORDER_ID:'90000001',ORDER_ITEM_ID:'90000002',PRODUCT_ID:'133559',IPN_TYPE_NAME:'OrderCharged',ORDER_STATUS:'Processed',TEST_MODE:'0',CUSTOMER_EMAIL:'fixture@example.test'}:{idempotency_key:'fixture',order_id:'90000001'};
 const result=await context.run(input);assert.equal(result[destination==='Kajabi'?'alreadyDelivered':'alreadySent'],true);assert.equal(sends,0);assert.equal(unlocks,1);
});
