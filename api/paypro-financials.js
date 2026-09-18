import {parseBody,validSignature,liveFinancials,getOrder,snapshot} from '../lib/paypro-financials.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({ok:false});}
  try {
    const data=parseBody(req.body);
    if(!validSignature(data,process.env.PAYPRO_VALIDATION_KEY)) return res.status(401).json({ok:false});
    // Read-only diagnostics reveal financial totals, never customer data.
    if(data.financial_dry_run===true){const x=snapshot(await getOrder(data.ORDER_ID),data.ORDER_ID);return res.status(200).json({ok:true,order:x.order,net:x.net/100,refunded:x.refunded/100,status:x.status});}
    return res.status(200).json({ok:true,...await liveFinancials(data)});
  } catch(error){console.error('PAYPRO FINANCIAL RECONCILIATION REQUIRED',{reason:error.message});return res.status(503).json({ok:false,financial_retry_required:true});}
}
