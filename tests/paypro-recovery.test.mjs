import test from 'node:test';
import assert from 'node:assert/strict';
import {jobId,completed,enqueueSigned,processJob,ENQUEUE,FINISH,PREFIX} from '../lib/paypro-recovery.js';
import worker from '../api/paypro-recovery-worker.js';

const payment={ORDER_ID:'90000001',ORDER_ITEM_ID:'90000002',PRODUCT_ID:'133559',IPN_TYPE_NAME:'OrderCharged',SIGNATURE:'fixture',ORDER_PLACED_TIME_UTC:'2026-10-11T00:00:00Z'};
function memory() {
  const values=new Map(),due=new Map();
  const store=async([op,...a])=>{
    if(op==='GET')return values.get(a[0])??null;
    if(op==='SET'){if(a.includes('NX')&&values.has(a[0]))return null;values.set(a[0],a[1]);return 'OK';}
    if(op==='EVAL'&&a[0]===ENQUEUE){const[,,job,done,,data,time,id]=a;if(values.has(done))return 0;if(!values.has(job))values.set(job,data);if(!due.has(id))due.set(id,Number(time));return 1;}
    if(op==='EVAL'&&a[0]===FINISH){const[,,lock,job,done,,token,state,id,time]=a;if(values.get(lock)!==token)return 0;if(state==='done'){values.set(done,'1');values.delete(job);due.delete(id);}else due.set(id,Number(time));values.delete(lock);return 1;}
    throw Error('Unexpected storage operation');
  };
  return {store,values,due};
}
test('main and bump have different jobs; identical delivery retains identity',()=>{
  assert.equal(jobId(payment),jobId({...payment}));
  assert.notEqual(jobId(payment),jobId({...payment,ORDER_ITEM_ID:'90000003',PRODUCT_ID:'133565'}));
});
test('partial success, busy destination, and missing session are not completion',()=>{
  for(const body of [{ok:true,processing:true},{ok:true,reason:'secure_session_rejected'},
    {ok:true,reason:'checkout_bump_item_ipn',kajabi_access_updated:false},
    {ok:true,secure_session_verified:true,sent_to_cometly:true,kajabi_access_updated:false}])
    assert.equal(completed({code:200,body}),false);
  assert.equal(completed({code:200,body:{ok:true,reason:'checkout_bump_item_ipn',kajabi_already_updated:true}}),true);
});
test('failure retains original data and timestamp; later successful duplicate is suppressed',async()=>{
  const m=memory(),id=await enqueueSigned(payment,{store:m.store,now:()=>100});
  await assert.rejects(processJob(id,async()=>{throw Error('provider timeout')},{store:m.store,now:()=>200}));
  assert.equal(JSON.parse(m.values.get(PREFIX+'job:'+id)).data.ORDER_PLACED_TIME_UTC,payment.ORDER_PLACED_TIME_UTC);
  assert.equal(m.due.get(id),300200);
  let calls=0;const process=async data=>{calls++;assert.deepEqual(data,payment);return {code:200,body:{ok:true,secure_session_verified:true,sent_to_cometly:true,kajabi_access_updated:true}};};
  await processJob(id,process,{store:m.store});
  await enqueueSigned(payment,{store:m.store});
  await processJob(id,process,{store:m.store});
  assert.equal(calls,1);assert.equal(m.values.has(PREFIX+'job:'+id),false);assert.equal(m.due.has(id),false);
});
test('concurrent worker does not process a leased job twice',async()=>{
  const m=memory(),id=await enqueueSigned(payment,{store:m.store});
  m.values.set(PREFIX+'lock:'+id,'other-worker');
  const result=await processJob(id,()=>{throw Error('must not process')},{store:m.store});
  assert.equal(result.busy,true);assert.equal(m.values.get(PREFIX+'lock:'+id),'other-worker');
});
test('cron rejects unauthenticated requests before any API or storage access',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='fixture-secret';
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};
  await worker({method:'GET',headers:{authorization:'Bearer wrong'}},res);assert.equal(res.code,401);
  if(old===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;
});
