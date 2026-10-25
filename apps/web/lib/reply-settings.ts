// Pure Reply settings logic. Client-safe: no core runtime import (the profile rules are pinned to
// core's applyProfileDefaults by reply-settings.test.ts).
import { autoApproveChipText } from "./approvals";

export type Profile = "general" | "healthcare" | "legal";
export type Pack = "hipaa" | "legal_ethics";
export type AutoChoice = "off" | "4" | "5";

/** workspaceSettings.get output. */
export type SettingsValues = {
  workspaceId: string;
  profile: Profile;
  packs: Pack[];
  skipPositiveReviews: boolean;
  genericTemplatesOnly: boolean;
  staffNames: string[];
  autoApproveMinStars: 4 | 5 | null;
  autoPublish: boolean;
  h2Severity: "block" | "warn";
  draftOnArrival: boolean;
  /** Who turned automatic approval on and when (ISO); null while off, or when it was set before this was recorded. */
  autoApproveEnabledBy: { userId: string; name: string } | null;
  autoApproveEnabledAt: string | null;
  /** True for a HIPAA covered entity: auto-approve and auto-publish are locked off. */
  autoApproveLocked: boolean;
};

export type FormState = {
  profile: Profile;
  packs: Pack[];
  skip: boolean;
  staffText: string;
  auto: AutoChoice;
  autoPublish: boolean;
  h2: "block" | "warn";
  draftOnArrival: boolean;
};

export const PROFILES: { value: Profile; label: string; help: string }[] = [
  { value: "general", label: "General", help: "No extra rules." },
  {
    value: "healthcare",
    label: "Healthcare",
    help: "Turns on HIPAA rules and blocks replies to 4-5 star reviews by default.",
  },
  { value: "legal", label: "Legal", help: "Turns on legal-ethics rules." },
];

export const PACKS: { value: Pack; label: string }[] = [
  { value: "hipaa", label: "HIPAA" },
  { value: "legal_ethics", label: "Legal ethics" },
];

export const AUTO_OPTIONS: { value: AutoChoice; label: string }[] = [
  { value: "off", label: "Nothing" },
  { value: "4", label: "4-5 star reviews" },
  { value: "5", label: "5 star reviews only" },
];

const label = (p: Profile) => PROFILES.find((x) => x.value === p)!.label;

/** The pack a profile turns on and that cannot be removed while it is selected. */
export function requiredPack(profile: Profile): Pack | null {
  return profile === "healthcare" ? "hipaa" : profile === "legal" ? "legal_ethics" : null;
}

/** What genericTemplatesOnly will be after saving this form (only a profile switch changes it). */
export function genericOnlyAfterSave(initial: SettingsValues, form: FormState): boolean {
  return form.profile === initial.profile ? initial.genericTemplatesOnly : form.profile === "healthcare";
}

export function formFromSettings(s: SettingsValues): FormState {
  return {
    profile: s.profile,
    packs: [...s.packs],
    skip: s.skipPositiveReviews,
    staffText: s.staffNames.join("\n"),
    auto: s.autoApproveMinStars === null ? "off" : (String(s.autoApproveMinStars) as AutoChoice),
    autoPublish: s.autoPublish,
    h2: s.h2Severity,
    draftOnArrival: s.draftOnArrival,
  };
}

/** Auto-publish only applies to auto-approved replies, so turning auto-approve off clears it. */
export function chooseAuto(form: FormState, auto: AutoChoice): FormState {
  return { ...form, auto, autoPublish: auto === "off" ? false : form.autoPublish };
}

export function parseStaffNames(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The same limits as workspaceSettings.update (200 names, 2 to 80 characters), with readable text. */
export function staffNamesError(names: string[]): string | null {
  if (names.length > 200) return "INVALID_INPUT: Staff names: at most 200 lines.";
  if (names.some((n) => n.length < 2 || n.length > 80)) {
    return "INVALID_INPUT: Staff names: each name needs 2 to 80 characters.";
  }
  return null;
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** workspaceSettings.update input: only what changed, so a profile switch can apply its defaults. */
export function settingsUpdate(
  initial: SettingsValues,
  form: FormState,
): { workspaceId: string } & Record<string, unknown> {
  const input: { workspaceId: string } & Record<string, unknown> = { workspaceId: initial.workspaceId };
  if (form.profile !== initial.profile) input.profile = form.profile;
  if (!sameSet(form.packs, initial.packs)) input.packs = form.packs;
  if (form.skip !== initial.skipPositiveReviews) input.skipPositiveReviews = form.skip;
  const staff = parseStaffNames(form.staffText);
  if (staff.join("\n") !== initial.staffNames.join("\n")) input.staffNames = staff;
  const min = form.auto === "off" ? null : (Number(form.auto) as 4 | 5);
  if (min !== initial.autoApproveMinStars) input.autoApproveMinStars = min;
  if (form.autoPublish !== initial.autoPublish) input.autoPublish = form.autoPublish;
  if (form.h2 !== initial.h2Severity) input.h2Severity = form.h2;
  if (form.draftOnArrival !== initial.draftOnArrival) input.draftOnArrival = form.draftOnArrival;
  return input;
}

export function profileSwitchNotice(initial: SettingsValues, form: FormState): string | null {
  return form.profile === initial.profile
    ? null
    : `Saving applies the ${label(form.profile)} defaults to the packs and the 4-5 star rule. Review them before you save.`;
}

/** The chip as it would read after saving: other workspaces' saved rules plus this form's choice. */
export function previewChipText(others: (4 | 5 | null)[], auto: AutoChoice): string | null {
  return autoApproveChipText([...others, auto === "off" ? null : (Number(auto) as 4 | 5)]);
}
