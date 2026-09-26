import { BlockList, isIP } from "node:net";

// IANA special-purpose registries, reviewed 2026-09-26. This classifies
// addresses; it cannot prove that a public address belongs to a shopper.
const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) nonPublicV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]
]) nonPublicV6.addSubnet(address, prefix, "ipv6");
const publicV6Exceptions = new BlockList();
for (const [address, prefix] of [
  ["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128],
  ["2001:3::", 32], ["2001:4:112::", 48],
  ["2001:20::", 28], ["2001:30::", 28]
]) publicV6Exceptions.addSubnet(address, prefix, "ipv6");

export function normalizePublicIp(value) {
  if (typeof value !== "string") return "";
  const ip = value.trim();
  // No ports, chains, zone IDs, control characters or coercion of arrays.
  if (!ip || ip.length > 45 || /[%\s]/.test(ip)) return "";
  const family = isIP(ip);
  if (family === 4) {
    if (ip === "192.0.0.9" || ip === "192.0.0.10") return ip;
    return nonPublicV4.check(ip, "ipv4") ? "" : ip;
  }
  if (family !== 6) return "";
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  // Normalize mapped IPv4 before classification, including hexadecimal form.
  const mapped = normalized.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return normalizePublicIp([high >> 8, high & 255, low >> 8, low & 255].join("."));
  }
  // Only global unicast allocations are suitable as native visitor IPv6.
  if (!globalV6.check(normalized, "ipv6")) return "";
  if (publicV6Exceptions.check(normalized, "ipv6")) return normalized;
  return nonPublicV6.check(normalized, "ipv6") ? "" : normalized;
}

export function getBrowserRequestIp(headers = {}) {
  // api.flexiblest.io connects directly to Vercel. Do not trust a caller's
  // cf-connecting-ip or hop list. A malformed preferred header fails closed;
  // it must not downgrade trust to a lower-priority, possibly supplied value.
  for (const name of ["x-vercel-forwarded-for", "x-forwarded-for", "x-real-ip"]) {
    if (headers[name] !== undefined) {
      const ip = normalizePublicIp(headers[name]);
      return { ip, source: ip ? name : "none" };
    }
  }
  return { ip: "", source: "none" };
}

export function selectVisitorIp(payproIp, sessionIp) {
  const paymentIp = normalizePublicIp(payproIp);
  if (paymentIp) return { ip: paymentIp, source: "paypro_customer_ip" };
  const storedIp = normalizePublicIp(sessionIp);
  return { ip: storedIp, source: storedIp ? "browser_session" : "none" };
}
