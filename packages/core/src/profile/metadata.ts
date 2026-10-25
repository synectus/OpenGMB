import { PROFILE_METADATA } from "../config/profile-metadata";
import type {
  GoogleAttributeMetadata,
  GoogleCategoryMetadata,
  GoogleClient,
  GoogleLocation,
} from "../google/client";

type Reader = Pick<GoogleClient, "listCategories" | "batchGetCategories" | "listAttributeMetadata">;

/**
 * Module-level on purpose: every action builds a fresh client (google/factory.ts), so a cache on the
 * client would never hit. One cache per process (web, MCP, worker); see config/profile-metadata.ts.
 */
const cache = new Map<string, { at: number; value: unknown }>();
let clock = () => Date.now();

export function resetMetadataCacheForTests() {
  cache.clear();
}
export function setMetadataClockForTests(now: (() => number) | null) {
  clock = now ?? (() => Date.now());
}

function peek(key: string): { value: unknown } | undefined {
  const hit = cache.get(key);
  return hit && clock() - hit.at < PROFILE_METADATA.cacheTtlMs ? { value: hit.value } : undefined;
}
function put(key: string, value: unknown) {
  cache.delete(key);
  cache.set(key, { at: clock(), value });
  while (cache.size > PROFILE_METADATA.cacheMaxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = peek(key);
  if (hit) return hit.value as T;
  const value = await load();
  put(key, value);
  return value;
}

/** Region and language for metadata calls: address region, else the language's region, else the defaults. */
export function metadataLocale(
  loc: Pick<GoogleLocation, "languageCode"> & { storefrontAddress?: { regionCode?: string } },
): { regionCode: string; languageCode: string } {
  const languageCode = loc.languageCode?.trim() || PROFILE_METADATA.defaultLanguageCode;
  const fromLanguage = /^[a-z]{2,3}-([a-z]{2})$/i.exec(languageCode)?.[1]?.toUpperCase();
  return {
    regionCode:
      loc.storefrontAddress?.regionCode?.trim().toUpperCase() ||
      fromLanguage ||
      PROFILE_METADATA.defaultRegionCode,
    languageCode,
  };
}

type Locale = { regionCode: string; languageCode: string };
export type CategoryOut = { name: string; displayName: string };
export type CategoryFullOut = CategoryOut & {
  serviceTypes: { serviceTypeId: string; displayName: string }[];
};
export type AttributeOut = {
  name: string;
  displayName: string;
  groupDisplayName: string;
  valueType: "BOOL" | "ENUM" | "URL" | "REPEATED_ENUM";
  repeatable: boolean;
  values: { value: unknown; displayName: string }[];
};

const basic = (c: GoogleCategoryMetadata): CategoryOut => ({
  name: c.name,
  displayName: c.displayName ?? c.name,
});
const full = (c: GoogleCategoryMetadata): CategoryFullOut => ({
  ...basic(c),
  serviceTypes: (c.serviceTypes ?? []).map((s) => ({
    serviceTypeId: s.serviceTypeId,
    displayName: s.displayName ?? s.serviceTypeId,
  })),
});

export function toAttributeOut(a: GoogleAttributeMetadata): AttributeOut {
  return {
    name: a.parent.startsWith("attributes/") ? a.parent : `attributes/${a.parent}`,
    displayName: a.displayName ?? a.parent,
    groupDisplayName: a.groupDisplayName ?? "Other",
    valueType: a.valueType as AttributeOut["valueType"],
    repeatable: a.repeatable ?? false,
    values: (a.valueMetadata ?? []).map((v) => ({
      value: v.value,
      displayName: v.displayName ?? String(v.value),
    })),
  };
}

/** categories.list by display name; one page; nothing below the minimum length. */
export async function searchCategories(
  client: Reader,
  p: Locale & { query: string },
): Promise<CategoryOut[]> {
  // Category names never contain `"` or `\`, and Google's escape rules inside the quotes are
  // unverified, so strip them rather than escape.
  const query = p.query.replace(/["\\]/g, "").trim();
  if (Array.from(query).length < PROFILE_METADATA.searchMinChars) return [];
  return cached(
    `categories.search|${p.regionCode}|${p.languageCode}|${query.toLowerCase()}`,
    async () => {
      const r = await client.listCategories({
        regionCode: p.regionCode,
        languageCode: p.languageCode,
        view: "BASIC",
        // Always quoted: Google answers 400 INVALID_ARGUMENT ("displayName is the only supported
        // filter") to an unquoted multi-word value (verified live 2026-10-19).
        filter: `displayName="${query}"`,
        pageSize: PROFILE_METADATA.searchPageSize,
      });
      return r.categories.map(basic);
    },
  );
}

/** categories.batchGet (FULL) for the names not cached yet; unknown names are cached as absent. */
export async function getCategories(
  client: Reader,
  p: Locale & { names: string[] },
): Promise<CategoryFullOut[]> {
  const key = (n: string) => `categories.get|${p.regionCode}|${p.languageCode}|${n}`;
  const names = [...new Set(p.names)];
  const missing = names.filter((n) => !peek(key(n)));
  if (missing.length > 0) {
    const r = await client.batchGetCategories({
      names: missing,
      languageCode: p.languageCode,
      regionCode: p.regionCode,
      view: "FULL",
    });
    for (const n of missing) {
      const found = r.categories.find((c) => c.name === n);
      put(key(n), found ? full(found) : null);
    }
  }
  return names.flatMap((n) => {
    const v = peek(key(n))?.value as CategoryFullOut | null | undefined;
    return v ? [v] : [];
  });
}

/** attributes.list for a primary category, all pages, deprecated and untyped ones left out. */
export async function listAttributes(
  client: Reader,
  p: Locale & { categoryName: string },
): Promise<AttributeOut[]> {
  return cached(`attributes|${p.regionCode}|${p.languageCode}|${p.categoryName}`, async () => {
    const out: AttributeOut[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < PROFILE_METADATA.attributesMaxPages; page++) {
      const r = await client.listAttributeMetadata({
        categoryName: p.categoryName,
        regionCode: p.regionCode,
        languageCode: p.languageCode,
        pageSize: PROFILE_METADATA.attributesPageSize.limit,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const a of r.attributeMetadata) {
        if (a.deprecated || !a.valueType || a.valueType === "ATTRIBUTE_VALUE_TYPE_UNSPECIFIED")
          continue;
        out.push(toAttributeOut(a));
      }
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  });
}
