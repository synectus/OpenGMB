import {
  runGuardrails,
  withExtraViolations,
  type GuardrailContext,
  type GuardrailResult,
  type Violation,
} from "../guardrails";
import { touchedNames, type ProfileValues } from "./fields";

/**
 * The guardrail context for writing `after` (the changed fields only) to one location. The subject
 * the guardrails bind to is the canonical JSON of every field and attribute being written, so
 * anything changed after the check cannot ride on an earlier pass.
 */
export function profileGuardrailContext(
  after: ProfileValues,
  location: { name: string; phone: string | null },
): GuardrailContext {
  const f = after.fields;
  const description = typeof f.description === "string" ? f.description : "";
  return {
    contentType: "profile",
    profile: {
      ...(f.title != null ? { title: f.title as string } : {}),
      ...(description ? { description } : {}),
      ...(f.regularHours !== undefined ? { regularHours: f.regularHours as never } : {}),
      ...(f.specialHours !== undefined ? { specialHours: f.specialHours as never } : {}),
      ...(f.phoneNumbers !== undefined ? { phoneNumbers: f.phoneNumbers as never } : {}),
      ...(f.categories !== undefined ? { categories: f.categories } : {}),
      ...(f.serviceItems !== undefined ? { serviceItems: f.serviceItems } : {}),
      ...(f.serviceArea !== undefined ? { serviceArea: f.serviceArea } : {}),
      ...(f.websiteUri !== undefined ? { websiteUri: f.websiteUri } : {}),
      ...(f.openingDate !== undefined ? { openingDate: f.openingDate } : {}),
      ...(f.storeCode !== undefined ? { storeCode: f.storeCode } : {}),
      ...(f.storefrontAddress !== undefined ? { storefrontAddress: f.storefrontAddress } : {}),
      ...(Object.keys(after.attributes).length > 0 ? { attributes: after.attributes } : {}),
    },
    reply: description,
    review: { rating: null, text: null, reviewerDisplayName: null },
    location,
    workspace: { profile: "general", packs: [], skipPositiveReviews: false, staffNames: [] },
    recentReplies: [],
  };
}

export function checkProfile(
  after: ProfileValues,
  location: { name: string; phone: string | null },
  /** The values being replaced (the diff's `before`). Service text already there is not checked again. */
  before?: ProfileValues,
): { ctx: GuardrailContext; result: GuardrailResult } {
  const ctx = profileGuardrailContext(after, location);
  return {
    ctx,
    result: withExtraViolations(runGuardrails(ctx), ctx, serviceTextViolations(ctx, before)),
  };
}

type ServiceItemText = {
  structuredServiceItem?: { serviceTypeId?: string; description?: string };
  freeFormServiceItem?: { label?: { displayName?: string; description?: string } };
};

/**
 * The same text rules (links, email, hashtags, writing style, the profile pack) on every service the
 * change writes: each description, and the name of an own service (customers see both). A violation
 * names the service, since its offsets would not mean anything in the description field.
 */
function serviceTextViolations(ctx: GuardrailContext, before?: ProfileValues): Violation[] {
  const items = ctx.profile?.serviceItems;
  if (!Array.isArray(items)) return [];
  // Text that is already on the profile is not ours to block: only new or changed text is checked.
  const known = new Set<string>();
  const old = before?.fields.serviceItems;
  if (Array.isArray(old)) {
    for (const raw of old as ServiceItemText[]) {
      const s = raw.structuredServiceItem;
      const f = raw.freeFormServiceItem?.label;
      if (s) known.add(`${s.serviceTypeId}|description|${s.description ?? ""}`);
      if (f) {
        known.add(`${f.displayName}|name|${f.displayName}`);
        known.add(`${f.displayName}|description|${f.description ?? ""}`);
      }
    }
  }
  const out: Violation[] = [];
  const check = (text: string | undefined, label: string, key: string) => {
    if (!text || text.trim() === "" || known.has(key)) return;
    const r = runGuardrails({ ...ctx, profile: {}, reply: text });
    for (const v of r.violations) {
      out.push({ ruleId: v.ruleId, packId: v.packId, severity: v.severity, status: v.status, message: `${label}: ${v.message}` });
    }
  };
  for (const raw of items as ServiceItemText[]) {
    const s = raw.structuredServiceItem;
    const f = raw.freeFormServiceItem?.label;
    if (s) check(
        s.description,
        `Service "${s.serviceTypeId ?? "from Google's list"}" description`,
        `${s.serviceTypeId}|description|${s.description ?? ""}`,
      );
    if (f) {
      const name = f.displayName ?? "";
      check(name, `Service name "${name}"`, `${name}|name|${name}`);
      check(f.description, `Service "${name}" description`, `${name}|description|${f.description ?? ""}`);
    }
  }
  return out;
}

/** Merge per-location results for storing/display; ok only if every one is ok. */
export function mergeResults(results: GuardrailResult[]): GuardrailResult {
  const seen = new Set<string>();
  const violations = results
    .flatMap((r) => r.violations)
    .filter((v) => {
      const k = `${v.ruleId}|${v.severity}|${v.message}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  return {
    ok: results.every((r) => r.ok),
    violations,
    packs: results[0]?.packs ?? ["universal", "profile"],
  };
}

export const blockedRuleIds = (r: GuardrailResult) => [
  ...new Set(r.violations.filter((v) => v.severity === "block").map((v) => v.ruleId)),
];

export { touchedNames };
