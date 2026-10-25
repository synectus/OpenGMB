import { CoreError } from "../errors";

/** R3: the only variables a reply template may use. */
export const TEMPLATE_VARIABLES = ["reviewer_first_name", "location_name", "phone"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** Values for rendering. null/empty = not available, which is an error if the template uses it. */
export type TemplateVars = Partial<Record<TemplateVariable, string | null>>;

/** Rendering failed because a value the template needs is missing. `variable` names it. */
export class TemplateRenderError extends CoreError {
  constructor(
    public readonly variable: TemplateVariable,
    message: string,
  ) {
    super("INVALID_INPUT", message);
    this.name = "TemplateRenderError";
  }
}

const TOKEN = /\{([^{}]*)\}/g;
const isVariable = (name: string): name is TemplateVariable =>
  (TEMPLATE_VARIABLES as readonly string[]).includes(name);

/** Variable names used in the body, in order of first use. Unknown names are included as written. */
export function templateTokens(body: string): string[] {
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1]!))];
}

/** Save-time check: any `{name}` that is not a known variable is INVALID_INPUT. */
export function validateTemplateBody(body: string): void {
  const unknown = templateTokens(body).filter((t) => !isVariable(t));
  if (unknown.length > 0) {
    throw new CoreError(
      "INVALID_INPUT",
      `Unknown template variable ${unknown.map((u) => `{${u}}`).join(", ")}. Allowed: ${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(", ")}`,
    );
  }
}

/** Generic = uses no reviewer-specific variable. Computed, never user-set. */
export function isGenericTemplate(body: string): boolean {
  return !templateTokens(body).includes("reviewer_first_name");
}

const ANONYMOUS_NAMES = new Set(["a google user", "anonymous", "google user"]);

/** First whitespace-separated token of the display name; null when the reviewer is anonymous. */
export function reviewerFirstName(displayName: string | null, isAnonymous: boolean): string | null {
  if (isAnonymous || displayName === null) return null;
  const name = displayName.trim();
  if (name === "" || ANONYMOUS_NAMES.has(name.toLowerCase())) return null;
  return name.split(/\s+/)[0]!;
}

/** Plain substitution in one pass (a value containing `{phone}` is not expanded again). */
export function renderTemplate(body: string, vars: TemplateVars): string {
  validateTemplateBody(body);
  return body.replace(TOKEN, (_, name: TemplateVariable) => {
    const value = vars[name]?.trim();
    if (value) return value;
    throw new TemplateRenderError(
      name,
      name === "reviewer_first_name"
        ? "reviewer name unavailable"
        : name === "phone"
          ? "Template uses {phone} but the location has no phone number"
          : `Template uses {${name}} but it has no value`,
    );
  });
}
