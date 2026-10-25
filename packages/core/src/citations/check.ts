import { CITATION_CHECK, type CitationCheckLimits } from "../config/citation-check";
import { compareNap, type NapFields, type Profile } from "./nap";
import { safeFetch, type SafeFetchResult } from "./safe-fetch";

export type CheckOutcome = {
  result: "match" | "mismatch" | "not_found" | "could_not_fetch";
  detail: { fields?: NapFields; reason?: string };
};

export type CheckDeps = {
  fetch?: (url: string) => Promise<SafeFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<CitationCheckLimits>;
};

/** Test hook: the fetcher the actions use. Null restores the real one. Production never sets it. */
let injected: ((url: string) => Promise<SafeFetchResult>) | null = null;
export const setListingFetcher = (f: ((url: string) => Promise<SafeFetchResult>) | null) => {
  injected = f;
};

/** A fetch that did not return a page is never a mismatch: it is "could not fetch", or "not found" for a gone page. */
export function outcomeOf(r: SafeFetchResult, profile: Profile): CheckOutcome {
  if (r.ok) {
    const c = compareNap(r.html, profile);
    return { result: c.result, detail: { fields: c.fields } };
  }
  if (r.reason === "http_error" && (r.status === 404 || r.status === 410)) return { result: "not_found", detail: { reason: "page_gone" } };
  return { result: "could_not_fetch", detail: { reason: r.reason } };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return u;
  }
};

/**
 * Check listings. Different hosts run at the same time (up to `concurrency`); listings on the same
 * host run one after another, `perHostDelayMs` apart. A listing not started when `runBudgetMs` is
 * spent gets null (left unchecked). Returns one entry per item, in order.
 */
export async function runChecks(items: { url: string }[], profile: Profile, deps: CheckDeps = {}): Promise<(CheckOutcome | null)[]> {
  const limits = { ...CITATION_CHECK, ...deps.limits };
  const doFetch = deps.fetch ?? injected ?? ((u: string) => safeFetch(u, { limits }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + limits.runBudgetMs;
  const out: (CheckOutcome | null)[] = items.map(() => null);
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => {
    const h = hostOf(it.url);
    groups.set(h, [...(groups.get(h) ?? []), i]);
  });
  const queue = [...groups.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      let last: number | null = null;
      for (const i of group) {
        if (last !== null) {
          const wait = limits.perHostDelayMs - (Date.now() - last);
          if (wait > 0) await sleep(wait);
        }
        if (Date.now() >= deadline) return;
        out[i] = outcomeOf(await doFetch(items[i]!.url), profile);
        last = Date.now();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limits.concurrency, queue.length)) }, worker));
  return out;
}
