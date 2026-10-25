import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF guard for outgoing webhooks. There is deliberately no environment switch that turns it off.
 * Tests relax it only through an injected `LookupPolicy`, which production code never passes.
 *
 * Two layers, because Node connects to an IP-literal host without calling `lookup`:
 *  - `validateWebhookUrl` rejects literals and names that resolve to a blocked address (at create
 *    and again before every send).
 *  - `guardedLookup` is passed to `https.request`, so the address that is checked is the address
 *    that is connected to. That closes DNS rebinding.
 */

/** [network, prefix length]. Private, loopback, link-local, CGNAT, multicast, reserved, documentation. */
export const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // IPv4-compatible (deprecated)
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4 embeds an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, "ipv6");

/** Parses an IPv6 literal to 8 16-bit groups, or null. Accepts "::", a dotted IPv4 tail and a zone id. */
function parseV6(raw: string): number[] | null {
  let s = raw.split("%")[0]!;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (isIP(dotted[2]!) !== 4) return null;
    const o = dotted[2]!.split(".").map(Number);
    s = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when `ip` is an address a webhook must never reach. Anything that is not an IP is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.split("%")[0]!);
  if (kind === 4) return blockList.check(ip, "ipv4");
  if (kind !== 6) return true;
  const g = parseV6(ip);
  if (!g) return true;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) wrap an IPv4 address: judge that address.
  // Unwrapped by hand so the result never depends on how a Node version treats these forms.
  if (zeros(0, 5) && g[5] === 0xffff) return blockList.check(v4FromGroups(g[6]!, g[7]!), "ipv4");
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return blockList.check(v4FromGroups(g[6]!, g[7]!), "ipv4");
  return blockList.check(g.map((x) => x.toString(16)).join(":"), "ipv6");
}

/** Test-only relaxations, passed as a dependency. Production callers never pass one. */
export type LookupPolicy = {
  allowAddress?: (ip: string) => boolean;
  allowPort?: (port: number) => boolean;
};

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolve: Resolver = (host) => dnsLookup(host, { all: true });

const isBlocked = (ip: string, policy?: LookupPolicy) =>
  isBlockedAddress(ip) && !policy?.allowAddress?.(ip);

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid_url" | "scheme" | "userinfo" | "port" | "blocked_address" | "dns" };

export async function validateWebhookUrl(
  raw: string,
  deps: { resolve?: Resolver; policy?: LookupPolicy } = {},
): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  const port = url.port === "" ? 443 : Number(url.port);
  if (port !== 443 && !deps.policy?.allowPort?.(port)) return { ok: false, reason: "port" };

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isBlocked(host, deps.policy) ? { ok: false, reason: "blocked_address" } : { ok: true, url };
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "blocked_address" };
  let addresses: { address: string }[];
  try {
    addresses = await (deps.resolve ?? defaultResolve)(host);
  } catch {
    return { ok: false, reason: "dns" };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns" };
  if (addresses.some((a) => isBlocked(a.address, deps.policy))) return { ok: false, reason: "blocked_address" };
  return { ok: true, url };
}

/**
 * A `lookup` for `https.request`: resolves every address and refuses when ANY is blocked, so a
 * public A record next to a private one cannot be used.
 */
export function guardedLookup(policy?: LookupPolicy, resolve: Resolver = defaultResolve) {
  return (
    hostname: string,
    options: { all?: boolean } | undefined,
    cb: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
  ): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isBlocked(a.address, policy))) {
          const err: NodeJS.ErrnoException = new Error(`blocked address for ${hostname}`);
          err.code = "WEBHOOK_BLOCKED_ADDRESS";
          cb(err);
          return;
        }
        if (options?.all) cb(null, addresses);
        else cb(null, addresses[0]!.address, addresses[0]!.family);
      },
      (e: NodeJS.ErrnoException) => cb(e),
    );
  };
}
