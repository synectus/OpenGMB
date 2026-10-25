/** Anchor id of an editor section, shared by the section menu and the command palette. */
export function sectionId(label: string) {
  return `section-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
