import { publicLimits } from "../limits/config";
import { clientIpFromForwardedFor } from "../limits/window";

/**
 * Claude registers a new OAuth client (DCR) on every fresh connection, and all of those registrations come from
 * Anthropic's shared egress range, so the normal 10 an hour per address would refuse real users once the connector is
 * listed. Callers from this range get TRUSTED_REGISTER_RATE_LIMIT instead.
 * Externally owned fact: re-check the source before relying on it.
 */
export const ANTHROPIC_EGRESS = {
  cidrs: ["160.79.104.0/21"],
  source: "https://claude.com/docs/connectors/building/authentication",
  verifiedOn: "2026-11-12",
} as const;

/** Registrations an hour per address inside ANTHROPIC_EGRESS (our own choice, not Anthropic's). */
export const TRUSTED_REGISTER_RATE_LIMIT = { window: 3600, max: 600 } as const;

/** IPv4 only (the published range is IPv4). An IPv4-mapped IPv6 address is read as the IPv4 it wraps. */
function ipv4ToInt(ip: string): number | null {
  const v4 = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
  const parts = v4.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  return cidrs.some((c) => {
    const [base, bits] = c.split("/");
    const net = ipv4ToInt(base ?? "");
    const len = Number(bits);
    if (net === null || !Number.isInteger(len) || len < 0 || len > 32) return false;
    const size = 2 ** (32 - len);
    return Math.floor(addr / size) === Math.floor(net / size);
  });
}

/**
 * Better-Auth customRules entry for /oauth2/register. The address is the one the nearest proxy saw
 * (clientIpFromForwardedFor, the same derivation the other limiters use); a left-hand X-Forwarded-For entry is client
 * controlled and never counts, and with no proxy configured the header is not trusted at all.
 */
export function registerRateRule(
  req: Request,
  current: { window: number; max: number },
  proxyHops: number = publicLimits().proxyHops,
  cidrs: readonly string[] = ANTHROPIC_EGRESS.cidrs,
): { window: number; max: number } {
  const ip = clientIpFromForwardedFor(req.headers.get("x-forwarded-for"), proxyHops);
  return ipInCidrs(ip, cidrs) ? { ...TRUSTED_REGISTER_RATE_LIMIT } : current;
}
