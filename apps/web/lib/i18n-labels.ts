// A nav label is its own English text; the message files key by it (nav.items.<label>). A label
// with no key renders as-is, and lib/i18n.test.ts fails for it, so none ships unnoticed.
type Translate = { has: (key: string) => boolean; (key: string): string };

export function labelFor(t: Translate, group: "groups" | "items" | "badges", label: string): string {
  const key = `${group}.${label}`;
  return t.has(key) ? t(key) : label;
}
