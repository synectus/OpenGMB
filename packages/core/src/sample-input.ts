import type { z } from "zod";
import type { AnyAction } from "./registry";

/**
 * Test helper: the smallest input that passes an action's zod schema, for tests that must reach a
 * handler or a gate for every action in the registry (the isolation test, the token scope test).
 * Walks zod 4 internals. Fields in `known` (by name) take their value from there; optional fields
 * and defaults are left out unless named in `known`.
 */
type Def = {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  entries?: Record<string, string>;
  options?: z.ZodType[];
  values?: unknown[];
  in?: z.ZodType;
  out?: z.ZodType;
  format?: string;
  checks?: { _zod: { def: { check: string; value?: number | bigint; minimum?: number } } }[];
};
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

const FIELD_SAMPLES: Record<string, unknown> = {
  from: "2026-01-01",
  to: "2026-01-31",
  endMonth: "2026-01",
  email: "someone@example.test",
  body: "Thank you for your review.",
  reason: "because",
  name: "a name",
  contentBase64: "aGVsbG8=",
  filename: "a.png",
  sourceUrl: "https://example.test/a.png",
  uri: "https://example.test/",
  regionCode: "US",
  languageCode: "en",
  query: "dentist",
  login: "someone@example.test",
  password: "not-a-real-password",
};

function sample(s: z.ZodType, field: string): unknown {
  const d = defOf(s);
  if (field in FIELD_SAMPLES && ["string", "pipe"].includes(d.type)) return FIELD_SAMPLES[field];
  switch (d.type) {
    case "optional":
    case "default":
    case "nullable":
    case "readonly":
      return sample(d.innerType!, field);
    case "pipe":
      return sample(d.in!, field);
    case "string": {
      if (d.format === "uuid") return crypto.randomUUID();
      if (d.format === "email") return "someone@example.test";
      if (d.format === "url") return "https://example.test/";
      if (d.format === "date-time") return "2026-01-01T00:00:00.000Z";
      let min = 1;
      for (const c of d.checks ?? []) {
        if (c._zod.def.check === "min_length") min = Math.max(min, Number(c._zod.def.minimum));
      }
      return "x".repeat(min);
    }
    case "number":
    case "int": {
      let v = 1;
      for (const c of d.checks ?? []) {
        if (c._zod.def.check === "greater_than") v = Math.max(v, Number(c._zod.def.value));
      }
      return v;
    }
    case "boolean":
      return false;
    case "enum":
      return Object.values(d.entries!)[0];
    case "literal":
      return d.values![0];
    case "array":
      return [sample(d.element!, field)];
    case "object": {
      return Object.fromEntries(
        Object.entries(d.shape!)
          .filter(([, v]) => !["optional", "default"].includes(defOf(v).type))
          .map(([k, v]) => [k, sample(v, k)]),
      );
    }
    case "union":
      return sample(d.options![0]!, field);
    case "record":
      return {};
    case "date":
      return new Date("2026-01-01T00:00:00Z");
    default:
      return undefined;
  }
}

/** Inputs the generic filler cannot get right on its own (patterns, cross-field rules). */
const GOOGLE_MEDIA = "accounts/1/locations/1/media/1";
const GOOGLE_LINK = "locations/1/placeActionLinks/1";
const INPUT_PATCH: Record<string, Record<string, unknown>> = {
  "workspaces.setTimeSettings": { timeZone: "UTC" },
  "locations.import": {
    locations: [{ accountName: "accounts/1", locationName: "locations/1" }],
  },
  "reviews.analytics": { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z" },
  "posts.calendar": { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T00:00:00.000Z" },
  "geogrid.competitors": { runId: crypto.randomUUID() },
  "reports.definitions.create": { customFrom: null, customTo: null },
  "profile.categories.get": { names: ["categories/gcid:dentist"] },
  "profile.attributes.metadata": { categoryName: "categories/gcid:dentist" },
  "media.delete": { mediaName: GOOGLE_MEDIA },
  "placeActions.update": { name: GOOGLE_LINK },
  "placeActions.delete": { name: GOOGLE_LINK },
  "foodMenus.update": {
    menus: [
      {
        labels: [{ displayName: "Menu" }],
        sections: [
          {
            labels: [{ displayName: "Mains" }],
            items: [
              {
                labels: [{ displayName: "Soup" }],
                attributes: { price: { currencyCode: "USD", units: "5", nanos: 0 } },
              },
            ],
          },
        ],
      },
    ],
  },
};

/** A schema-valid input for `action`. `known` supplies values (e.g. foreign ids) by field name. */
export function sampleInput(
  action: Pick<AnyAction, "name" | "input">,
  known: (field: string) => unknown = () => undefined,
): Record<string, unknown> {
  const shape = (action.input as z.ZodObject).shape as Record<string, z.ZodType>;
  const input: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(shape)) {
    const given = known(k);
    if (given !== undefined) input[k] = given;
    else if (!["optional", "default"].includes(defOf(s).type)) input[k] = sample(s, k);
  }
  return { ...input, ...(INPUT_PATCH[action.name] ?? {}) };
}
