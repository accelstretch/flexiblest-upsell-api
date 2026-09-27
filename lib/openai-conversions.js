import { createHash } from 'node:crypto';
import { normalizePublicIp } from './visitor-ip.js';

export const DAY = 86400000;
export function opaque(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\s\u0000-\u001f\u007f]/.test(value) ? value : '';
}
// Separate namespace: never merged into Cometly or PayPro URL fields.
export function sanitizeOpenAI(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.allowed === false) return { allowed: false };
  if (value.allowed !== true) return null;
  const result = { allowed: true };
  const captured = Number(value.captured_at);
  if (Number.isSafeInteger(captured) && captured <= now + 600000 && captured >= now - 30 * DAY) {
    const ref = opaque(value.oppref);
    if (ref) { result.oppref = ref; result.captured_at = captured; }
  }
  const obref = opaque(value.obref);
  if (obref) result.obref = obref;
  return result;
}

export function minorUnits(raw, currency) {
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('invalid_amount');
  if (!Intl.supportedValuesOf('currency').includes(currency)) throw new Error('invalid_currency');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.slice(digits).replace(/0/g, '')) throw new Error('amount_precision');
  const n = BigInt(whole) * (10n ** BigInt(digits)) + BigInt((fraction.slice(0, digits).padEnd(digits, '0')) || '0');
  if (n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid_amount');
  return Number(n);
}
export function eventTime(raw) {
  // PayPro declares this field UTC. Accept explicit ISO and common UTC SQL format.
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+]00:00)?$/.test(raw)) throw new Error('invalid_time');
  const datePart = raw.slice(0, 10);
  const normalized = raw.replace(' ', 'T').replace(/[+]00:00$/, 'Z');
  const time = Date.parse(normalized.endsWith('Z') ? normalized : normalized + 'Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== datePart) throw new Error('invalid_time');
  return time;
}
export function buildOpenAIEvent(record, now = Date.now()) {
  const d = record?.payment, session = record?.session;
  if (!d || !session || session.openai?.allowed !== true) return null;
  if (d.ORDER_STATUS !== 'Processed' || d.IPN_TYPE_NAME !== 'OrderCharged' || !['0','false'].includes(d.TEST_MODE)) return null;
  if (d.PRODUCT_ID !== '133559' || !/^\d+$/.test(d.ORDER_ID) || d.ORDER_ID !== session.paypro_root_order_id) return null;
  const timestamp = eventTime(d.ORDER_PLACED_TIME_UTC);
  if (timestamp > now + 600000 || timestamp <= now - 7 * DAY) throw new Error('event_time_out_of_range');
  const currency = d.ORDER_CURRENCY_CODE;
  const amount = minorUnits(d.ORDER_TOTAL_AMOUNT, currency);
  const event = { id: `paypro-${d.ORDER_ID}-purchase`, type: 'order_created', timestamp_ms: timestamp,
    action_source: 'web', source_url: 'https://flexiblest.com/secure-checkout', data: { type: 'contents', amount, currency } };
  const attribution = sanitizeOpenAI(session.openai, timestamp);
  if (attribution?.oppref) event.oppref = attribution.oppref;
  const user = {};
  if (attribution?.obref) user.obref = attribution.obref;
  const email = typeof d.CUSTOMER_EMAIL === 'string' ? d.CUSTOMER_EMAIL.trim().toLowerCase() : '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) user.emails_sha256 = [createHash('sha256').update(email, 'utf8').digest('hex')];
  const ip = normalizePublicIp(session.request_context?.ip_address);
  if (ip) user.ip_address = ip;
  const ua = session.request_context?.user_agent;
  if (typeof ua === 'string' && ua.trim() && ua.length <= 1500) user.user_agent = ua;
  if (Object.keys(user).length) event.user = user;
  return event;
}

export async function sendOpenAI(event, { env = process.env, fetcher = fetch, validateOnly = false } = {}) {
  if (!env.OPENAI_CONVERSIONS_API_KEY || !/^[A-Za-z0-9_-]+$/.test(env.OPENAI_ADS_PIXEL_ID || '')) throw new Error('missing_openai_configuration');
  const response = await fetcher(`https://bzr.openai.com/v1/events?pid=${env.OPENAI_ADS_PIXEL_ID}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_CONVERSIONS_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ validate_only: validateOnly, events: [event] }), signal: AbortSignal.timeout(8000)
  });
  // Never log provider bodies, request identity, or credentials.
  return { ok: response.ok, status: response.status };
}
