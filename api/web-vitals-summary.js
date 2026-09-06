export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  return res.status(200).json({
    ok: true,
    note: 'Web Vitals are recorded in Vercel function logs as flexiblest_web_vital records. Use Vercel logs to aggregate LCP, CLS, INP, FCP and TTFB by source, placement and device.'
  });
}
