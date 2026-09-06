const allowedOrigins = new Set([
  'https://flexiblest.com',
  'https://www.flexiblest.com'
]);

export default async function handler(req, res) {
  const origin = String(req.headers.origin || '');
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const metric = String(b.metric || '').slice(0, 16);
  const allowedMetrics = new Set(['LCP', 'CLS', 'INP', 'FCP', 'TTFB']);
  if (!allowedMetrics.has(metric)) return res.status(400).json({ ok: false });

  const value = Number(b.value);
  if (!Number.isFinite(value) || value < 0 || value > 120000) {
    return res.status(400).json({ ok: false });
  }

  const record = {
    type: 'flexiblest_web_vital',
    metric,
    value,
    rating: String(b.rating || '').slice(0, 24),
    page: String(b.page || '').slice(0, 120),
    source: String(b.source || '').slice(0, 40),
    placement: String(b.placement || '').slice(0, 80),
    device: String(b.device || '').slice(0, 24),
    ts: new Date().toISOString()
  };
  console.log(JSON.stringify(record));
  return res.status(204).end();
}
