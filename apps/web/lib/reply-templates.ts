// Client-safe mirror of core's template rules (packages/core/src/reviews/templates.ts) for live
// feedback while typing. Core validates again on save; reply-templates.test.ts pins the two together.

export const TEMPLATE_VARIABLES = ["reviewer_first_name", "location_name", "phone"] as const;

export const VARIABLE_HELP: { name: string; meaning: string }[] = [
  { name: "{reviewer_first_name}", meaning: "The first name of the person who left the review." },
  { name: "{location_name}", meaning: "The name of the location being replied for." },
  { name: "{phone}", meaning: "The location phone number." },
];

const SAMPLE: Record<(typeof TEMPLATE_VARIABLES)[number], string> = {
  reviewer_first_name: "Jordan",
  location_name: "Sample Clinic",
  phone: "(555) 010-0100",
};

const TOKEN = /\{([^{}]*)\}/g;
const known = (n: string): n is (typeof TEMPLATE_VARIABLES)[number] =>
  (TEMPLATE_VARIABLES as readonly string[]).includes(n);

/** Variable names used in the body, in order of first use (unknown ones as written). */
export function templateTokens(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]!))];
}

export function analyseTemplate(body: string): { unknown: string[]; generic: boolean; preview: string } {
  const tokens = templateTokens(body);
  return {
    unknown: tokens.filter((t) => !known(t)),
    generic: !tokens.includes("reviewer_first_name"),
    preview: body.replace(TOKEN, (whole, n: string) => (known(n) ? SAMPLE[n] : whole)),
  };
}

export function unknownVariableText(unknown: string[]): string | null {
  return unknown.length === 0 ? null : `Unknown variable ${unknown.map((u) => `{${u}}`).join(", ")}`;
}

/** A template that names the reviewer cannot be used in a workspace set to generic templates only. */
export const notAllowedHere = (generic: boolean, genericOnly: boolean): boolean => genericOnly && !generic;
