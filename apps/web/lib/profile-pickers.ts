import { attributeLabel } from "./labels";
// Pure logic for the Google metadata pickers on /locations/[id]/profile. Client-safe: types only from core.
export type CategoryMeta = {
  name: string;
  displayName: string;
  serviceTypes: { serviceTypeId: string; displayName: string }[];
};
export type AttributeMeta = {
  name: string;
  displayName: string;
  groupDisplayName: string;
  valueType: "BOOL" | "ENUM" | "URL" | "REPEATED_ENUM";
  repeatable: boolean;
  values: { value: unknown; displayName: string }[];
};

export const shortId = (name: string) => name.replace(/^categories\//, "");

export function categoryTag(
  name: string,
  primary: string,
  additional: string[],
): "Primary" | "Additional" | null {
  if (name === primary) return "Primary";
  return additional.includes(name) ? "Additional" : null;
}

export function choosePrimary(
  additional: string[],
  name: string,
): { primary: string; additional: string[] } {
  return { primary: name, additional: additional.filter((x) => x !== name) };
}

export function addAdditional(primary: string, additional: string[], name: string): string[] {
  return name === primary || additional.includes(name) ? additional : [...additional, name];
}

export function localeLine(regionCode: string, languageCode: string): string {
  const region = new Intl.DisplayNames(["en"], { type: "region" }).of(regionCode) ?? regionCode;
  const base = languageCode.split("-")[0] ?? languageCode;
  const language = new Intl.DisplayNames(["en"], { type: "language" }).of(base) ?? languageCode;
  return `Google's categories for ${region}, ${language}.`;
}

/** Social profile links: only the ids Google offers for the category are shown (an assumption checked at runtime). */
export const SOCIAL_IDS = ["attributes/url_facebook", "attributes/url_instagram"] as const;
export const socialAttributes = (metas: AttributeMeta[]) =>
  SOCIAL_IDS.flatMap((id) => metas.filter((m) => m.name === id));

export function attributeGroups(
  metas: AttributeMeta[],
  query: string,
): { group: string; items: AttributeMeta[] }[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, AttributeMeta[]>();
  for (const m of metas) {
    if ((SOCIAL_IDS as readonly string[]).includes(m.name)) continue;
    if (q && !m.displayName.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q))
      continue;
    groups.set(m.groupDisplayName, [...(groups.get(m.groupDisplayName) ?? []), m]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

type Value =
  | {
      values?: unknown[];
      uriValues?: { uri: string }[];
      repeatedEnumValue?: { setValues?: string[]; unsetValues?: string[] };
    }
  | null
  | undefined;

export type BoolChoice = "yes" | "no" | "unset";
export function boolChoice(v: unknown): BoolChoice {
  const x = (v as Value)?.values?.[0];
  return x === true ? "yes" : x === false ? "no" : "unset";
}
export const boolValue = (c: BoolChoice): unknown =>
  c === "unset" ? null : { values: [c === "yes"] };

export const enumOf = (v: unknown): string => String((v as Value)?.values?.[0] ?? "");
export const enumValue = (value: string): unknown => (value ? { values: [value] } : null);

export const repeatedOf = (v: unknown): string[] =>
  (v as Value)?.repeatedEnumValue?.setValues ?? [];
export function repeatedValue(selected: string[], before: string[]): unknown {
  const unset = before.filter((x) => !selected.includes(x));
  if (selected.length === 0 && unset.length === 0) return null;
  return {
    repeatedEnumValue: {
      ...(selected.length ? { setValues: [...selected].sort() } : {}),
      ...(unset.length ? { unsetValues: unset.sort() } : {}),
    },
  };
}

export const uriOf = (v: unknown): string => (v as Value)?.uriValues?.[0]?.uri ?? "";
export const uriValue = (uri: string): unknown =>
  uri.trim() ? { uriValues: [{ uri: uri.trim() }] } : null;

/** Attribute values that differ from Google's, by id; null deletes. Only these are sent. */
export function changedAttributes(
  original: Record<string, unknown>,
  now: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of new Set([...Object.keys(original), ...Object.keys(now)])) {
    const a = original[name] ?? null;
    const b = now[name] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[name] = b;
  }
  return out;
}

export function attributeSummary(
  meta: AttributeMeta | undefined,
  value: unknown,
  name = meta?.name ?? "",
): string {
  const label = meta?.displayName ?? attributeLabel(name);
  const v = value as Value;
  const named = (x: unknown) => meta?.values.find((m) => m.value === x)?.displayName ?? String(x);
  let text = "Not set";
  if (v?.uriValues?.length) text = v.uriValues.map((u) => u.uri).join(", ");
  else if (v?.repeatedEnumValue?.setValues?.length)
    text = v.repeatedEnumValue.setValues.map(named).join(", ");
  else if (v?.values?.length)
    text = v.values.map((x) => (x === true ? "Yes" : x === false ? "No" : named(x))).join(", ");
  return `${label}: ${text}`;
}

export function serviceTypesFor(
  categories: CategoryMeta[],
): { serviceTypeId: string; displayName: string }[] {
  const seen = new Map<string, string>();
  for (const c of categories)
    for (const s of c.serviceTypes)
      if (!seen.has(s.serviceTypeId)) seen.set(s.serviceTypeId, s.displayName);
  return [...seen].map(([serviceTypeId, displayName]) => ({ serviceTypeId, displayName }));
}
