"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { workspaceSettings_update } from "../app/_generated/actions";
import {
  AUTO_OPTIONS,
  chooseAuto,
  formFromSettings,
  genericOnlyAfterSave,
  PACKS,
  parseStaffNames,
  previewChipText,
  PROFILES,
  profileSwitchNotice,
  requiredPack,
  settingsUpdate,
  staffNamesError,
  type AutoChoice,
  type SettingsValues,
} from "../lib/reply-settings";
import { useTimeFormat } from "./time-format-provider";
import { ProvenanceChip } from "./approvals/provenance-chip";
import { AutoApproveChipView } from "./auto-approve-chip-view";
import { buttonClass, ErrorText, inputClass, linkClass } from "./ui";

export type { SettingsValues };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

const check = "size-4 accent-primary";

export function WorkspaceSettingsForm({
  initial,
  otherRules,
  canConfigure,
}: {
  initial: SettingsValues;
  /** autoApproveMinStars of every other workspace the caller can see, for the chip preview. */
  otherRules: (4 | 5 | null)[];
  canConfigure: boolean;
}) {
  const t = useTranslations("settings.replyForm");
  const tf = useTimeFormat();
  const router = useRouter();
  const [form, setForm] = useState(() => formFromSettings(initial));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const staffError = staffNamesError(parseStaffNames(form.staffText));
    if (staffError) return setError(staffError);
    setPending(true);
    setError(null);
    const result = await workspaceSettings_update(settingsUpdate(initial, form));
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setSaved(true);
    router.refresh();
  }

  const required = requiredPack(form.profile);
  const notice = profileSwitchNotice(initial, form);
  const chipText = previewChipText(otherRules, form.auto);
  const profileLabel = PROFILES.find((p) => p.value === form.profile)!.label;

  return (
    <form onSubmit={onSubmit} aria-label={t("formLabel")} className="flex flex-col gap-4">
      {!canConfigure && (
        <p role="status" className="rounded-panel border border-info-border bg-info-bg px-4 py-3 text-sm text-info">
          {t("ownersOnly")}
        </p>
      )}
      <fieldset disabled={!canConfigure || pending} className="flex flex-col gap-4">
        <Section title={t("profile")}>
          <div role="radiogroup" aria-label={t("profile")} className="grid gap-2 sm:grid-cols-3">
            {PROFILES.map((p) => {
              const on = form.profile === p.value;
              return (
                <label
                  key={p.value}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-control border p-3 text-sm ${
                    on ? "border-brand bg-brand-tint" : "border-border bg-card"
                  }`}
                >
                  <input
                    type="radio"
                    name="profile"
                    checked={on}
                    onChange={() => set({ profile: p.value })}
                    className={`${check} mt-0.5`}
                  />
                  <span>
                    <span className="block font-semibold">{p.label}</span>
                    <span className="block text-muted-foreground">{p.help}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-[13px] text-muted-foreground">
            {t("switchNote")}
          </p>
          {notice && (
            <p role="status" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
              {notice}
            </p>
          )}
        </Section>

        <Section title={t("rulePacks")}>
          {PACKS.map((p) => {
            const isRequired = required === p.value;
            return (
              <label key={p.value} className="flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className={check}
                  checked={isRequired || form.packs.includes(p.value)}
                  disabled={isRequired}
                  onChange={(e) =>
                    set({
                      packs: e.target.checked
                        ? [...form.packs, p.value]
                        : form.packs.filter((x) => x !== p.value),
                    })
                  }
                />
                {p.label}
                {isRequired && (
                  <span className="text-muted-foreground">{t("requiredBy", { profile: profileLabel })}</span>
                )}
              </label>
            );
          })}
        </Section>

        <Section title={t("positive")}>
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className={`${check} mt-0.5`}
              checked={form.skip}
              onChange={(e) => set({ skip: e.target.checked })}
            />
            <span>
              <span className="block font-semibold">{t("skipTitle")}</span>
              <span className="block text-muted-foreground">
                {t("skipHelp")}
              </span>
            </span>
          </label>
        </Section>

        {(required === "hipaa" || form.packs.includes("hipaa")) && (
          <Section title={t("h2")}>
            <div role="radiogroup" aria-label={t("h2")} className="flex gap-6 text-sm">
              {(["block", "warn"] as const).map((v) => (
                <label key={v} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="h2"
                    className={check}
                    checked={form.h2 === v}
                    onChange={() => set({ h2: v })}
                  />
                  {v === "block" ? t("block") : t("warn")}
                </label>
              ))}
            </div>
          </Section>
        )}

        <Section title={t("staffNames")}>
          <label htmlFor="staff" className="text-sm font-semibold">
            {t("staffNames")} <span className="font-normal text-muted-foreground">{t("staffHint")}</span>
          </label>
          <textarea
            id="staff"
            rows={5}
            value={form.staffText}
            onChange={(e) => set({ staffText: e.target.value })}
            className={`${inputClass} resize-y`}
          />
          <p className="text-[13px] text-muted-foreground">
            {t("staffHelp")}
          </p>
        </Section>

        <Section title={t("templates")}>
          <label className="flex items-center gap-2.5 text-sm">
            <input type="checkbox" className={check} checked={genericOnlyAfterSave(initial, form)} disabled readOnly />
            {t("genericOnly")}
          </label>
          <p className="text-[13px] text-muted-foreground">{t("genericHelp")}</p>
        </Section>

        <Section title={t("arrivalTitle")}>
          <label className="flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              className={check}
              checked={form.draftOnArrival}
              onChange={(e) => set({ draftOnArrival: e.target.checked })}
            />
            {t("arrivalLabel")}
          </label>
          <p className="text-[13px] text-muted-foreground">{t("arrivalHelp")}</p>
        </Section>

        <section
          aria-labelledby="auto-h"
          className="flex flex-col gap-3 rounded-panel border border-warn-border bg-warn-bg p-(--panel-p) shadow-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="auto-h" className="font-display text-lg font-bold">
              {t("autoTitle")}
            </h2>
            <span className="inline-flex h-[22px] items-center rounded-full bg-secondary px-2.5 text-xs font-bold text-secondary-foreground">
              {form.auto === "off" ? t("offByDefault") : t("on")}
            </span>
          </div>
          <p className="text-[13px] font-semibold text-bad">
            {t("autoWarning")}
          </p>
          {initial.autoApproveLocked && (
            <p role="note" className="text-[13px] font-semibold text-bad">
              {t("autoLocked")}
            </p>
          )}
          <label className="flex max-w-xs flex-col gap-1.5 text-sm font-semibold">
            {t("autoApprove")}
            <select
              disabled={initial.autoApproveLocked}
              value={form.auto}
              onChange={(e) => {
                setSaved(false);
                setForm((f) => chooseAuto(f, e.target.value as AutoChoice));
              }}
              className={`${inputClass} font-medium`}
            >
              {AUTO_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className={`flex items-center gap-2.5 text-sm ${form.auto === "off" ? "text-muted-foreground" : ""}`}>
            <input
              type="checkbox"
              className={check}
              checked={form.autoPublish}
              disabled={form.auto === "off" || initial.autoApproveLocked}
              onChange={(e) => set({ autoPublish: e.target.checked })}
            />
            {t("autoPublish")}
          </label>
          <p className="text-[13px] text-warn">
            {t("autoNote")}
          </p>
          <p className="text-[13px] text-muted-foreground">{t("autoConsent")}</p>
          {initial.autoApproveMinStars !== null && (
            <p role="status" data-testid="auto-approve-record" className="text-[13px] font-semibold text-foreground">
              {initial.autoApproveEnabledBy && initial.autoApproveEnabledAt
                ? t("autoTurnedOn", { name: initial.autoApproveEnabledBy.name || initial.autoApproveEnabledBy.userId, date: tf.date(initial.autoApproveEnabledAt, initial.workspaceId) })
                : t("autoTurnedOnEarlier")}
            </p>
          )}
          <div className="flex flex-col items-start gap-1.5 rounded-control border border-border bg-card p-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t("chipPreview")}</span>
            {chipText ? (
              <AutoApproveChipView text={chipText} />
            ) : (
              <span className="text-sm">{t("noChip")}</span>
            )}
            <span className="text-[13px] text-muted-foreground">{t("chipShownOn")}</span>
            {form.auto !== "off" && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                {t("markedPrefix")}
                <span className="inline-flex h-6 items-center rounded-md border border-warn-border bg-warn-bg px-2 text-xs font-semibold text-warn">
                  {t("autoApprovedRule", { stars: form.auto })}
                </span>
                <ProvenanceChip surface="mcp" name={null} />
                {t("markedSuffix")}
              </div>
            )}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          {canConfigure && (
            <button type="submit" className={buttonClass}>
              {pending ? t("saving") : t("save")}
            </button>
          )}
          <span className="text-[13px] text-muted-foreground">
            {pending ? t("sendingChanged") : t("savedChanged")}
          </span>
          <Link href={`/settings/templates?ws=${initial.workspaceId}`} className={`${linkClass} ml-auto`}>
            {t("templatesLink")}
          </Link>
        </div>
      </fieldset>
      <ErrorText message={error} />
      {saved && (
        <p role="status" className="text-sm font-semibold text-good">
          {t("saved")}
        </p>
      )}
    </form>
  );
}
