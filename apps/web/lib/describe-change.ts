// Readable, field-aware summary of one changed profile field, for the Changes tab.
// Pure and client-safe. Returns typed lines (no prose) so the component can translate them.
import { plainValue } from "./labels";

export type ChangeLine =
  /** serviceArea: the address is hidden (service area only) or shown. null = no service area set. */
  | { type: "addressShown"; before: boolean | null; after: boolean | null }
  | { type: "placesAdded"; names: string[] }
  | { type: "placesRemoved"; names: string[] }
  | { type: "placesUnchanged"; count: number }
  /** Generic: one changed key or item. `before`/`after` null = not there on that side. */
  | { type: "key"; path: string; before: string | null; after: string | null };

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const LONG = 160;
const CONTEXT = 40;

/** A changed leaf as text. Long strings keep the changed part and trim the unchanged ends. */
function leaf(v: unknown, other: unknown): string | null {
  if (v === null || v === undefined) return null;
  const p = plainValue(v);
  if (typeof p !== "string") return String(p);
  if (p.length <= LONG || typeof other !== "string") return p;
  const o = String(plainValue(other));
  let pre = 0;
  while (pre < p.length && pre < o.length && p[pre] === o[pre]) pre++;
  let suf = 0;
  while (suf < p.length - pre && suf < o.length - pre && p[p.length - 1 - suf] === o[o.length - 1 - suf]) suf++;
  const from = Math.max(0, pre - CONTEXT);
  const to = Math.min(p.length, p.length - suf + CONTEXT);
  return `${from > 0 ? "..." : ""}${p.slice(from, to)}${to < p.length ? "..." : ""}`;
}

function walk(path: string, b: unknown, a: unknown, out: ChangeLine[]): void {
  if (same(b, a)) return;
  if (isObj(b) && isObj(a)) {
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      walk(path ? `${path}.${k}` : k, b[k], a[k], out);
    }
    return;
  }
  if (Array.isArray(b) && Array.isArray(a)) {
    const prim = (x: unknown[]) => x.every((i) => i === null || typeof i !== "object");
    if (prim(b) && prim(a)) {
      const gone = b.filter((x) => !a.some((y) => same(x, y)));
      const added = a.filter((x) => !b.some((y) => same(x, y)));
      if (gone.length || added.length) {
        out.push({
          type: "key",
          path,
          before: gone.length ? gone.map((x) => leaf(x, null)).join(", ") : null,
          after: added.length ? added.map((x) => leaf(x, null)).join(", ") : null,
        });
      }
      return;
    }
    for (let i = 0; i < Math.max(b.length, a.length); i++) walk(`${path}[${i + 1}]`, b[i], a[i], out);
    return;
  }
  // A leaf, or an object/array on one side only: show it whole so nothing is cut.
  const text = (v: unknown, o: unknown) =>
    v !== null && typeof v === "object" ? JSON.stringify(plainValue(v)) : leaf(v, o);
  out.push({ type: "key", path, before: text(b, a), after: text(a, b) });
}

type Place = { placeName?: string; placeId?: string };
type Area = { businessType?: string; places?: { placeInfos?: Place[] } };
const shown = (a: Area | null): boolean | null =>
  a?.businessType ? a.businessType === "CUSTOMER_AND_BUSINESS_LOCATION" : null;
const placesOf = (a: Area | null) => a?.places?.placeInfos ?? [];
const placeId = (p: Place) => p.placeId || p.placeName || "";
const placeName = (p: Place) => p.placeName || p.placeId || "";

function describeServiceArea(b: Area | null, a: Area | null): ChangeLine[] {
  const out: ChangeLine[] = [];
  if (shown(b) !== shown(a)) out.push({ type: "addressShown", before: shown(b), after: shown(a) });
  const bp = placesOf(b);
  const ap = placesOf(a);
  const added = ap.filter((p) => !bp.some((q) => placeId(q) === placeId(p))).map(placeName);
  const removed = bp.filter((p) => !ap.some((q) => placeId(q) === placeId(p))).map(placeName);
  if (removed.length) out.push({ type: "placesRemoved", names: removed });
  if (added.length) out.push({ type: "placesAdded", names: added });
  if (!added.length && !removed.length && ap.length) out.push({ type: "placesUnchanged", count: ap.length });
  return out;
}

/** What differs between two values of one profile field, as typed lines. Empty = nothing differs. */
export function describeChange(field: string, before: unknown, after: unknown): ChangeLine[] {
  if (same(before, after)) return [];
  if (field === "serviceArea" && (before === null || isObj(before)) && (after === null || isObj(after))) {
    return describeServiceArea(before as Area | null, after as Area | null);
  }
  const out: ChangeLine[] = [];
  walk("", before, after, out);
  return out;
}
