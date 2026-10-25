/**
 * X2: compare the name, address and phone on a directory page with the Google profile. Pure.
 *
 * A field can MATCH from anywhere in the page text. It can MISMATCH only from structured data the
 * page labels as the business (JSON-LD with a name, address or telephone): a directory page is full
 * of other businesses, its own support number and its own address, and a plain text search would
 * call those mismatches. Everything else is "not found", which the UI words as "open the listing to
 * compare".
 */
export type FieldResult = "match" | "mismatch" | "not_found";
export type NapFields = { name?: FieldResult; address?: FieldResult; phone?: FieldResult };
export type NapResult = "match" | "mismatch" | "not_found";
export type Profile = { name: string | null; address: string | null; phone: string | null };
export type NapComparison = { result: NapResult; fields: NapFields };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const htmlToText = (html: string) =>
  decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

/** Lower case, no accents, no apostrophes, "&" as "and", every other mark as a space. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** The last 9 digits, so +1 / +91 / +61 / a leading 0 all compare equal. Null under 7 digits. */
export function phoneKey(s: string): string | null {
  const d = s.replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-9) : null;
}

const ABBREV: Record<string, string> = {
  street: "st", road: "rd", avenue: "ave", boulevard: "blvd", drive: "dr", lane: "ln", suite: "ste", highway: "hwy",
  court: "ct", place: "pl", north: "n", south: "s", east: "e", west: "w", floor: "fl", building: "bldg", apartment: "apt",
  parkway: "pkwy", square: "sq", circle: "cir", terrace: "ter", unit: "ste",
};
const addressTokens = (s: string) => normalizeText(s).split(" ").filter(Boolean).map((t) => ABBREV[t] ?? t);

const POSTCODE = [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/, /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/];
/** The postcode of a profile address as tokens, and the address without it. */
function splitPostcode(addr: string): { pc: string[]; rest: string } {
  const upper = addr.toUpperCase();
  for (const re of POSTCODE) {
    const m = upper.match(re);
    if (m) return { pc: addressTokens(m[0]), rest: upper.replace(m[0], " ") };
  }
  const nums = [...upper.matchAll(/(?<![\dA-Z])\d{4,6}(?![\dA-Z])/g)];
  const last = nums[nums.length - 1];
  return last ? { pc: [last[0]], rest: upper.replace(last[0], " ") } : { pc: [], rest: upper };
}

/** True when the page tokens hold this address: street number and postcode together, most other words nearby. */
function addressOnPage(address: string, pageTokens: string[]): boolean {
  const { pc, rest } = splitPostcode(address);
  const toks = addressTokens(rest);
  const number = toks.find((t) => /^\d+[a-z]?$/.test(t));
  const words = toks.filter((t) => t !== number);
  if (!number && pc.length === 0) return false;
  const share = (win: string[]) => {
    const set = new Set(win);
    if (!pc.every((p) => set.has(p))) return false;
    return words.length === 0 || words.filter((w) => set.has(w)).length / words.length >= 0.6;
  };
  if (!number) return share(pageTokens);
  for (let i = 0; i < pageTokens.length; i++) {
    if (pageTokens[i] === number && share(pageTokens.slice(Math.max(0, i - 3), i + 18))) return true;
  }
  return false;
}

type Business = { name: string | null; phone: string | null; address: string | null };

function addressText(a: unknown): string | null {
  if (typeof a === "string") return a;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode"].map((k) => (typeof o[k] === "string" ? (o[k] as string) : ""));
    const joined = parts.filter(Boolean).join(" ");
    return joined || null;
  }
  return null;
}

function collectBusinesses(node: unknown, out: Business[], depth = 0): void {
  if (depth > 8 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collectBusinesses(n, out, depth + 1));
  const o = node as Record<string, unknown>;
  const name = typeof o.name === "string" ? decodeEntities(o.name) : null;
  const phone = typeof o.telephone === "string" ? o.telephone : null;
  const address = addressText(o.address);
  if (name && (phone || address)) out.push({ name, phone, address });
  for (const v of Object.values(o)) if (v && typeof v === "object") collectBusinesses(v, out, depth + 1);
}

function jsonLdBusinesses(html: string): Business[] {
  const out: Business[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectBusinesses(JSON.parse(m[1]!.trim()), out);
    } catch {
      // not JSON: ignore this block
    }
  }
  return out;
}

const PHONE_IN_TEXT = /\+?\d[\d\s().\-–]{5,}\d/g;

export function compareNap(html: string, profile: Profile): NapComparison {
  const text = htmlToText(html);
  const textNorm = ` ${normalizeText(text)} `;
  const tokens = addressTokens(text);
  const biz = jsonLdBusinesses(html);
  const fields: NapFields = {};

  if (profile.name?.trim()) {
    const want = ` ${normalizeText(profile.name)} `;
    const names = biz.map((b) => normalizeText(b.name ?? "")).filter(Boolean);
    const inLd = names.some((n) => ` ${n} `.includes(want));
    fields.name = textNorm.includes(want) || inLd ? "match" : names.length > 0 ? "mismatch" : "not_found";
  }

  const wantPhone = profile.phone ? phoneKey(profile.phone) : null;
  if (wantPhone) {
    const keys = new Set<string>();
    for (const m of text.matchAll(PHONE_IN_TEXT)) { const k = phoneKey(m[0]); if (k) keys.add(k); }
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) { const k = phoneKey(decodeURIComponent(m[1]!)); if (k) keys.add(k); }
    const structured = biz.map((b) => (b.phone ? phoneKey(b.phone) : null)).filter((k): k is string => !!k);
    fields.phone = keys.has(wantPhone) || structured.includes(wantPhone) ? "match" : structured.length > 0 ? "mismatch" : "not_found";
  }

  if (profile.address?.trim()) {
    const structured = biz.map((b) => b.address).filter((a): a is string => !!a);
    const inLd = structured.some((a) => addressOnPage(profile.address!, addressTokens(decodeEntities(a))));
    fields.address = addressOnPage(profile.address, tokens) || inLd ? "match" : structured.length > 0 ? "mismatch" : "not_found";
  }

  const values = Object.values(fields);
  if (values.includes("mismatch")) return { result: "mismatch", fields };
  const others = values.length - (fields.name ? 1 : 0);
  const otherMatches = (fields.address === "match" ? 1 : 0) + (fields.phone === "match" ? 1 : 0);
  const ok = fields.name === "match" && (others === 0 || otherMatches >= 1);
  return { result: ok ? "match" : "not_found", fields };
}
