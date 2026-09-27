import { timingSafeEqual } from 'node:crypto';
import { sendOpenAI } from '../lib/openai-conversions.js';
import { runWorker } from '../lib/openai-outbox.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({ok:false});
  const expected=process.env.CRON_SECRET;
  const supplied=String(req.headers.authorization||'');
  if(!expected || Buffer.byteLength(supplied)!==Buffer.byteLength('Bearer '+expected) || !timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+expected))) return res.status(401).json({ok:false});
  if(req.query?.validate_only === '1') {
    try {
      const result = await sendOpenAI({id:'validation-only',type:'order_created',timestamp_ms:Date.now(),action_source:'web',source_url:'https://flexiblest.com/secure-checkout',data:{type:'contents',amount:100,currency:'USD'}},{validateOnly:true});
      return res.status(result.ok?200:502).json({ok:result.ok,validation_only:true,provider_status:result.status});
    } catch {return res.status(503).json({ok:false,validation_only:true});}
  }
  try {return res.status(200).json({ok:true,...await runWorker()});}
  catch {console.error('OPENAI_QUEUE_RETRY_REQUIRED');return res.status(503).json({ok:false,retry_required:true});}
}
