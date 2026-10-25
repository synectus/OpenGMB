import { GOOGLE_RETRY } from "../config/google-retry";
import { googleRetryAfterMs, isGoogleRateLimit } from "./errors";

/** Seconds to wait before re-queue number `attempt` (0 = first): base, then doubling, capped. */
export function rateLimitDelaySec(attempt: number, retryAfterMs?: number): number {
  const exp = GOOGLE_RETRY.baseDelaySec * GOOGLE_RETRY.backoffFactor ** attempt;
  const asked = retryAfterMs ? Math.ceil(retryAfterMs / 1000) + 10 : 0;
  return Math.min(GOOGLE_RETRY.maxDelaySec, Math.max(exp, asked));
}

/** Seconds a scheduled job for the `index`th location of an org waits so the org does not burst. */
export function staggerSeconds(index: number): number {
  return Math.min(GOOGLE_RETRY.maxStaggerSeconds, index * GOOGLE_RETRY.staggerSecondsPerLocation);
}

/** Per-org stagger counter for a fan-out: call with each row's org id, in order. */
export function orgStagger(): (orgId: string) => number {
  const seen = new Map<string, number>();
  return (orgId) => {
    const i = seen.get(orgId) ?? 0;
    seen.set(orgId, i + 1);
    return staggerSeconds(i);
  };
}

export type RateLimitData = { rlAttempt?: number };

/**
 * Run a worker job body. When it fails because Google (or our org limiter) said "slow down" and
 * attempts remain, re-send the same job with `startAfter` and return normally: the job is
 * completed, not failed, so no retry attempt is used and no alert fires. `run` is told whether a
 * rate limit will be deferred (`canDefer`), so it must not mark its work failed in that case.
 * Past `maxAttempts` the error is rethrown and the job fails for real.
 */
export async function deferOnRateLimit(opts: {
  queue: string;
  data: RateLimitData & object;
  send: (queue: string, data: object, options: { startAfter: number }) => Promise<unknown>;
  run: (ctx: { canDefer: boolean }) => Promise<unknown>;
}): Promise<"done" | "deferred"> {
  const attempt = opts.data.rlAttempt ?? 0;
  const canDefer = attempt < GOOGLE_RETRY.maxAttempts;
  try {
    await opts.run({ canDefer });
    return "done";
  } catch (e) {
    if (!canDefer || !isGoogleRateLimit(e)) throw e;
    const delay = rateLimitDelaySec(attempt, googleRetryAfterMs(e));
    await opts.send(opts.queue, { ...opts.data, rlAttempt: attempt + 1 }, { startAfter: delay });
    console.warn(`[worker] ${opts.queue} rate limited, re-queued in ${delay}s (attempt ${attempt + 1}/${GOOGLE_RETRY.maxAttempts})`);
    return "deferred";
  }
}
