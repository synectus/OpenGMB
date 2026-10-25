import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { CITATION_CHECK, type CitationCheckLimits } from "../config/citation-check";
import { guardedLookup, isBlockedAddress, type LookupPolicy, type Resolver } from "../webhooks/ssrf";

/**
 * X2: fetch one directory page on a person's behalf, safely. Reuses the webhook SSRF block list
 * (private, loopback, link-local, metadata, IPv6 forms). The address is checked before connecting
 * and again at connect time (guardedLookup), and every redirect hop goes through the same checks.
 * Tests relax it only through an injected `policy`; production never passes one.
 */
export type FetchFailReason =
  | "invalid_url"
  | "scheme"
  | "userinfo"
  | "port"
  | "blocked_address"
  | "dns"
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "not_html"
  | "blocked_by_site"
  | "http_error"
  | "network";

export type SafeFetchResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; reason: FetchFailReason; status?: number };

export type SafeFetchDeps = { resolve?: Resolver; policy?: LookupPolicy; limits?: Partial<CitationCheckLimits> };

const defaultResolve: Resolver = (host) => dnsLookup(host, { all: true });
/** Statuses that mean the site refused a robot, not that the page is gone. */
const BOT_BLOCK = new Set([401, 403, 406, 429, 451, 503]);

type Hop =
  | { kind: "page"; html: string }
  | { kind: "redirect"; location: string }
  | { kind: "fail"; reason: FetchFailReason; status?: number };

async function checkUrl(url: URL, deps: SafeFetchDeps): Promise<FetchFailReason | null> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
  if (url.username || url.password) return "userinfo";
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443 && !deps.policy?.allowPort?.(port)) return "port";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const blocked = (ip: string) => isBlockedAddress(ip) && !deps.policy?.allowAddress?.(ip);
  if (isIP(host)) return blocked(host) ? "blocked_address" : null;
  if (host === "localhost" || host.endsWith(".localhost")) return "blocked_address";
  let addresses: { address: string }[];
  try {
    addresses = await (deps.resolve ?? defaultResolve)(host);
  } catch {
    return "dns";
  }
  if (addresses.length === 0) return "dns";
  return addresses.some((a) => blocked(a.address)) ? "blocked_address" : null;
}

function requestOnce(url: URL, deps: SafeFetchDeps, limits: CitationCheckLimits): Promise<Hop> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      req.destroy();
      finish({ kind: "fail", reason: "timeout" });
    }, limits.timeoutMs);
    const finish = (h: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(h);
    };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(deps.policy, deps.resolve ?? defaultResolve) as never,
        headers: { "user-agent": limits.userAgent, accept: "text/html,application/xhtml+xml;q=0.9" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return finish({ kind: "redirect", location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return finish({ kind: "fail", reason: BOT_BLOCK.has(status) ? "blocked_by_site" : "http_error", status });
        }
        if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(String(res.headers["content-type"] ?? ""))) {
          res.resume();
          return finish({ kind: "fail", reason: "not_html", status });
        }
        if (Number(res.headers["content-length"] ?? 0) > limits.maxBytes) {
          req.destroy();
          return finish({ kind: "fail", reason: "too_large", status });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > limits.maxBytes) {
            req.destroy();
            return finish({ kind: "fail", reason: "too_large", status });
          }
          chunks.push(c);
        });
        res.on("end", () => finish({ kind: "page", html: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish({ kind: "fail", reason: "network" }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) =>
      finish({ kind: "fail", reason: e.code === "WEBHOOK_BLOCKED_ADDRESS" ? "blocked_address" : "network" }),
    );
    req.end();
  });
}

export async function safeFetch(raw: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const limits: CitationCheckLimits = { ...CITATION_CHECK, ...deps.limits };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const refused = await checkUrl(url, deps);
    if (refused) return { ok: false, reason: refused };
    const r = await requestOnce(url, deps, limits);
    if (r.kind === "page") return { ok: true, html: r.html, finalUrl: url.toString() };
    if (r.kind === "fail") return { ok: false, reason: r.reason, ...(r.status ? { status: r.status } : {}) };
    try {
      url = new URL(r.location, url);
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
  }
  return { ok: false, reason: "too_many_redirects" };
}
