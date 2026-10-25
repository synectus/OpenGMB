// The hostname a request was addressed to, and whether it is the product's own (main) host.
// Behind a Traefik proxy, `x-forwarded-host` is the routed host (Traefik overwrites any client-sent value),
// so it wins over `host`. Used by proxy.ts, which has no database: it only needs "main or not".
export { isProductSitePath } from "./site-edition";

function firstHost(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first ? first : null;
}

/** Lowercase hostname without port, or null when the request names none. */
export function requestHost(headers: Headers): string | null {
  const raw = firstHost(headers.get("x-forwarded-host")) ?? firstHost(headers.get("host"));
  if (!raw) return null;
  // "[::1]:3000" keeps its brackets; "name:3000" loses the port.
  const host = raw.startsWith("[") ? raw.replace(/\]:\d+$/, "]") : raw.replace(/:\d+$/, "");
  return host || null;
}

/** True for the BETTER_AUTH_URL host, localhost and 127.0.0.1 (the container health check calls localhost:3000), and when no host is named. */
export function isMainHost(host: string | null, base: string | undefined = process.env.BETTER_AUTH_URL): boolean {
  if (!host) return true;
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (!base) return false;
  try {
    return new URL(base).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** May a user belonging to `userOrgIds` use this host? The main host: always. A custom host: only its own organization. */
export function hostAllowsOrg(hostOrgId: string | null, userOrgIds: readonly string[], isMain: boolean): boolean {
  if (isMain) return true;
  return hostOrgId !== null && userOrgIds.includes(hostOrgId);
}
