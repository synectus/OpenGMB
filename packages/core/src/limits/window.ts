/** Fixed-window counter per key, in process memory (each service is a single container). */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastPrune = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private current(key: string) {
    const t = this.now();
    // Expired windows are dropped at least once per window, so a key never outlives its window by more than that.
    if (t - this.lastPrune >= this.windowMs) {
      this.prune(t);
      this.lastPrune = t;
    }
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (this.windows.size >= 10_000) this.prune(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    return w;
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }

  /** Seconds until `key` may try again, or 0 when it is under the limit. Does not count. */
  blockedFor(key: string): number {
    const w = this.current(key);
    return w.count >= this.max ? Math.ceil((w.start + this.windowMs - this.now()) / 1000) : 0;
  }

  /** Count one event; returns the seconds to wait when it went over the limit, else 0. */
  hit(key: string): number {
    const w = this.current(key);
    w.count++;
    return w.count > this.max ? Math.ceil((w.start + this.windowMs - this.now()) / 1000) : 0;
  }

  /** Forget `key` (a successful sign-in clears that account's failures). */
  reset(key: string): void {
    this.windows.delete(key);
  }
}

/**
 * The caller's address from an X-Forwarded-For value. Behind a proxy that appends to the header,
 * the entry `proxyHops` from the right is the one the nearest proxy saw; anything further left is
 * client-controlled and ignored, so a spoofed header cannot pick another bucket. Without the
 * header, `fallback` (the socket address) or "unknown".
 */
export function clientIpFromForwardedFor(
  forwardedFor: string | string[] | null | undefined,
  proxyHops: number,
  fallback?: string,
): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const parts = raw
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts && parts.length > 0 && proxyHops > 0) {
    return parts[Math.max(0, parts.length - proxyHops)]!;
  }
  return fallback ?? "unknown";
}

export const intFromEnv = (
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
) => {
  const n = Number(env[name]);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};
