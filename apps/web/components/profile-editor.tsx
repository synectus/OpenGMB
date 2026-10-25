"use client";
import { LoaderCircle } from "lucide-react";
import { statusWords } from "@/lib/labels";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ai_draftBusinessDescription, profile_preview, profile_propose } from "../app/_generated/actions";
import { approvalsHref } from "../lib/approvals";
import {
  buildFields,
  changedLabels,
  formFromProfile,
  previewRows,
  proposeState,
  serviceChangeCards,
  type ProfileForm,
  type ServiceChange,
} from "../lib/profile-editor";
import { TableWrap, tdClass, thClass } from "./page-parts";
import { runCall } from "./post-card";
import { ProfileSectionMenu } from "./profile/section-menu";
import { type PreviewLoc, type Values } from "./profile-forms";
import { OpenChangeSets, type ChangeSetData } from "./profile/open-change-sets";
import { AiDraftButton } from "./profile/ai-draft";
import { AddressAndStoreCode } from "./profile/address-section";
import { AttributesSection, SocialProfiles } from "./profile/attributes-section";
import { CategoryPicker } from "./profile/category-picker";
import {
  EditorSection,
  fieldLabelClass,
  h2Class,
  sectionClass,
  usePhrase,
} from "./profile/section";
import {
  ContactFields,
  HoursGrid,
  ServiceAreaEditor,
  SpecialHoursList,
} from "./profile/sections";
import type { CopyTargets } from "./profile/copy-services-dialog";
import { ServicesManager } from "./profile/services-manager";
import { useProfileMetadata } from "./profile/use-profile-metadata";
import { Violations } from "./reply-panel";
import { buttonClass, ErrorText, inputClass, linkClass, secondaryButtonClass } from "./ui";

/** Where people connect an MCP agent today. Plan 5A moves this to /agents. */
const AGENT_HREF = "/settings/tokens";
const infoRow = "flex items-center gap-2 rounded-lg bg-info-bg px-3 py-2 text-sm font-semibold text-info";

export type ProfileLimits = {
  descriptionMax: number;
  serviceDescriptionMax: number;
  additionalPhonesMax: number;
  areaMaxPlaces: number;
  searchMinChars: number;
};

/**
 * One location's profile. The form starts from what Google has now. "Preview changes" asks core for
 * the per-field diff and guardrails (nothing written); "Propose" records exactly the previewed edit
 * as a change set that waits for a person in /approvals. Applying happens in the worker.
 */
export function ProfileEditor({
  locationId,
  workspaceId,
  profile,
  display,
  changeSets,
  limits,
  canEdit,
  canDraft = false,
  copyTargets,
}: {
  locationId: string;
  workspaceId: string;
  profile: Values;
  display: {
    categoryNames: Record<string, string>;
    regionCode: string;
    languageCode: string;
  };
  changeSets: ChangeSetData[];
  limits: ProfileLimits;
  canEdit: boolean;
  /** The user may draft text with AI (review:draft). */
  canDraft?: boolean;
  /** The workspace's other locations and groups, for Copy to locations. */
  copyTargets?: CopyTargets;
}) {
  const router = useRouter();
  const t = useTranslations("profile");
  const phrase = usePhrase();
  const [{ form: initial, ctx }] = useState(() => formFromProfile(profile, display.regionCode));
  const [form, setForm] = useState<ProfileForm>(initial);
  const patch = (p: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...p }));
  const metadata = useProfileMetadata({
    locationId,
    regionCode: display.regionCode,
    languageCode: display.languageCode,
    primary: form.primaryCategory,
    additional: form.additionalCategories,
  });
  const names = {
    ...display.categoryNames,
    ...Object.fromEntries(metadata.categories.map((c) => [c.name, c.displayName])),
  };
  const [busy, setBusy] = useState<"preview" | "propose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewLoc | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [recorded, setRecorded] = useState<{ id: string; status: string } | null>(null);

  const labels = changedLabels(initial, form, ctx);
  const fields = buildFields(initial, form, ctx);
  const currentKey = JSON.stringify(fields);
  const state = proposeState({ preview, previewKey, currentKey, acknowledged });
  const chars = Array.from(form.description).length;

  async function doPreview() {
    setBusy("preview");
    setError(null);
    setRecorded(null);
    setAcknowledged(false);
    const sent = buildFields(initial, form, ctx);
    const r = await runCall<{ locations: PreviewLoc[] }>(() =>
      profile_preview({ locationIds: [locationId], fields: sent }),
    );
    setBusy(null);
    if ("error" in r) return setError(r.error);
    setPreview(r.data.locations[0] ?? null);
    setPreviewKey(JSON.stringify(sent));
  }

  async function doPropose() {
    if (state.kind !== "ready" || !preview?.current) return;
    setBusy("propose");
    setError(null);
    const r = await runCall<{ changeSet: { id: string; status: string } }>(() =>
      profile_propose({
        workspaceId,
        locationIds: [locationId],
        fields,
        snapshots: [{ locationId, current: preview.current! }],
      }),
    );
    setBusy(null);
    if ("error" in r) return setError(r.error);
    setRecorded(r.data.changeSet);
    setPreview(null);
    setPreviewKey(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:gap-6">
      <ProfileSectionMenu />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
      <OpenChangeSets
        key={changeSets.map((c) => `${c.id}:${c.status}`).join(",")}
        initial={changeSets}
        locationId={locationId}
        onPreviewAgain={canEdit ? doPreview : undefined}
      />
      <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <legend className="sr-only">{t("editor.fields")}</legend>
        <EditorSection label="Name">
          <label className={fieldLabelClass}>
            {t("editor.businessName")}
            <input className={inputClass} value={form.title} onChange={(e) => patch({ title: e.target.value })} />
          </label>
        </EditorSection>
        <EditorSection label="Description">
          <label className={fieldLabelClass}>
            {t("sections.Description")}
            <textarea className={`${inputClass} min-h-28`} rows={5} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
          </label>
          {canEdit && canDraft && (
            <AiDraftButton
              hasText={form.description.trim() !== ""}
              onFill={(description) => patch({ description })}
              call={() =>
                ai_draftBusinessDescription({
                  locationId,
                  categories: [form.primaryCategory, ...form.additionalCategories]
                    .filter(Boolean)
                    .map((c) => names[c] ?? c)
                    .slice(0, 10),
                  services: form.own.map((o) => o.name.trim()).filter(Boolean).slice(0, 40),
                  ...(form.description.trim() ? { currentDescription: form.description.trim() } : {}),
                })
              }
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <Link href={AGENT_HREF} className={linkClass}>
              {t("editor.connectAgent")}
            </Link>
            <span className={chars > limits.descriptionMax ? "font-semibold text-bad" : "text-muted-foreground"}>
              {t("editor.chars", { chars, limit: limits.descriptionMax })}
            </span>
          </div>
        </EditorSection>
        <EditorSection label="Categories">
          <CategoryPicker
            locationId={locationId}
            regionCode={display.regionCode}
            languageCode={display.languageCode}
            minChars={limits.searchMinChars}
            primary={form.primaryCategory}
            additional={form.additionalCategories}
            names={names}
            onChange={(primaryCategory, additionalCategories) => patch({ primaryCategory, additionalCategories })}
          />
        </EditorSection>
        <EditorSection label="Regular hours">
          <HoursGrid rows={form.hours} kept={ctx.kept} onChange={(hours) => patch({ hours })} />
        </EditorSection>
        <EditorSection label="Special hours">
          <SpecialHoursList rows={form.special} onChange={(special) => patch({ special })} />
        </EditorSection>
        <EditorSection label="Services">
          <ServicesManager
            form={form}
            items={ctx.structured}
            categories={metadata.categories}
            names={names}
            regionCode={display.regionCode}
            sample={metadata.source === "sample"}
            loading={metadata.loading}
            descriptionMax={limits.serviceDescriptionMax}
            locationId={canEdit && canDraft ? locationId : undefined}
            copyTargets={canEdit ? copyTargets : undefined}
            onChange={patch}
          />
        </EditorSection>
        <AttributesSection
          metas={metadata.attributes}
          values={form.attributes}
          original={ctx.originalAttributes}
          loading={metadata.loading}
          error={metadata.error}
          onChange={(attributes) => patch({ attributes })}
        />
        <SocialProfiles
          metas={metadata.attributes}
          values={form.attributes}
          onChange={(attributes) => patch({ attributes })}
        />
        <EditorSection label="Service area">
          <ServiceAreaEditor area={form.area} max={limits.areaMaxPlaces} onChange={(area) => patch({ area })} />
        </EditorSection>
        <EditorSection label="Website, phone and opening date">
          <ContactFields form={form} maxPhones={limits.additionalPhonesMax} onChange={patch} />
        </EditorSection>
        <AddressAndStoreCode form={form} onChange={patch} />
      </fieldset>

      {(busy === "preview" || preview || error || recorded) && (
        <section aria-label={t("preview.sectionLabel")} className={sectionClass}>
          <h2 className={h2Class}>{t("preview.title")}</h2>
          {busy === "preview" && (
            <p role="status" className={infoRow}>
              <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
              {t("readingProfile")}
            </p>
          )}
          <ErrorText message={error} />
          {preview && busy !== "preview" && (
            <PreviewBody preview={preview} names={names} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
          )}
          {recorded && (
            <p role="status" aria-live="polite" className="text-sm">
              {t("preview.recorded", { status: statusWords(recorded.status) })}{" "}
              {recorded.status === "pending_approval" && (
                <Link className={linkClass} href={approvalsHref({ tab: "changeset", item: `changeset:${recorded.id}` })}>
                  {t("openApprovals")}
                </Link>
              )}
            </p>
          )}
        </section>
      )}

      {canEdit ? (
        <div data-editor-bar className="sticky bottom-0 z-10 flex items-center gap-2 rounded-panel border border-border bg-card p-2 shadow-card sm:gap-3 sm:p-3">
          <div className="mr-auto flex min-w-0 flex-col">
            <span className="truncate text-sm text-muted-foreground" aria-live="polite">
              {labels.length === 0
                ? t("bar.noChanges")
                : t("bar.changed", { count: labels.length, list: labels.map((l) => phrase(l)).join(", ") })}
            </span>
            {state.note && <span className="truncate text-xs font-semibold text-muted-foreground">{phrase(state.note)}</span>}
          </div>
          <button
            type="button"
            aria-label={t("bar.previewChanges")}
            className={`${secondaryButtonClass} shrink-0 max-sm:px-3`}
            disabled={busy !== null || labels.length === 0}
            onClick={doPreview}
          >
            <span className="sm:hidden">{t("bar.previewShort")}</span>
            <span className="max-sm:hidden">{t("bar.previewChanges")}</span>
          </button>
          {state.kind !== "hidden" && (
            <button type="button" className={`${buttonClass} shrink-0 max-sm:px-3`} disabled={busy !== null || state.kind !== "ready"} onClick={doPropose}>
              {t("bar.propose")}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("bar.readOnly")}</p>
      )}
      </div>
    </div>
  );
}

function PreviewBody({
  preview,
  names,
  acknowledged,
  onAcknowledge,
}: {
  preview: PreviewLoc;
  names: Record<string, string>;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  const t = useTranslations("profile");
  const phrase = usePhrase();
  if (preview.error) {
    return (
      <p role="alert" className="text-sm text-bad">
        <span className="font-mono">{preview.error}</span>: {t("preview.unreadable")}
      </p>
    );
  }
  if (preview.noChange) {
    return <p className="text-sm text-muted-foreground">{t("preview.noChange")}</p>;
  }
  const warns = preview.guardrail?.violations.some((v) => v.severity === "warn") ?? false;
  // Name, description, website and services are what a person typed: only the lib's own words are translated there.
  const typed = new Set(["Name", "Description", "Website", "Services"]);
  const rows = previewRows(preview.changes, names).map((r) => ({
    field: phrase(r.field),
    now: phrase(r.now, !typed.has(r.field)),
    next: phrase(r.next, !typed.has(r.field)),
    source: r.field,
  }));
  const serviceChange = preview.changes.find((c) => c.field === "serviceItems");
  const cards = serviceChange
    ? serviceChangeCards(serviceChange.before, serviceChange.after, (n) => names[n] ?? n.replace(/^categories\//, ""))
    : [];
  return (
    <>
      <ul aria-label={t("preview.changedFields")} className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
        {rows.map((r, i) =>
          r.source === "Services" && cards.length > 0 ? (
            cards.map((c, j) => <ServiceChangeCard key={`${i}-${j}`} change={c} />)
          ) : (
            <li key={`${r.field}-${i}`} className="rounded-control border border-border p-3 text-sm">
              <p className="m-0 font-semibold">{r.field}</p>
              <ChangeLine label={t("preview.now")} text={r.now} muted />
              <ChangeLine label={t("preview.proposed")} text={r.next} />
            </li>
          ),
        )}
      </ul>
      <div className="max-md:hidden">
      <TableWrap>
        <table className="w-full text-left text-sm">
          <thead className="bg-muted">
            <tr>
              <th scope="col" className={thClass}>{t("preview.field")}</th>
              <th scope="col" className={thClass}>{t("preview.onGoogle")}</th>
              <th scope="col" className={thClass}>{t("preview.proposed")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.field}-${i}`} className="border-t border-border">
                <td className={`${tdClass} font-semibold`}>{r.field}</td>
                <td className={`${tdClass} whitespace-pre-wrap text-muted-foreground`}>{r.now}</td>
                <td className={`${tdClass} whitespace-pre-wrap`}>{r.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        updateMask: {[...preview.updateMask, ...preview.attributeMask].join(", ")}
      </p>
      {preview.guardrail && <Violations result={preview.guardrail} />}
      {preview.guardrail?.ok && warns && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
          {t("preview.acknowledge")}
        </label>
      )}
    </>
  );
}

function ChangeLine({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  return (
    <p className="m-0 mt-1 flex gap-2">
      <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`min-w-0 whitespace-pre-wrap break-words ${muted ? "text-muted-foreground" : ""}`}>{text}</span>
    </p>
  );
}

/** One changed service on a phone: name, category, then before and after for price and description. */
function ServiceChangeCard({ change }: { change: ServiceChange }) {
  const t = useTranslations("profile");
  const none = t("preview.none");
  const field = (key: "price" | "description", label: string) => {
    const from = change.before ? change.before[key] || none : t("preview.notOnProfile");
    const to = change.after ? change.after[key] || none : t("preview.removed");
    return (
    <p className="m-0 mt-2 text-sm">
      <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {from === to ? (
        <span className="text-muted-foreground">{t("preview.unchanged", { value: to })}</span>
      ) : (
        <>
          <span className="text-muted-foreground">{from}</span> <span aria-hidden>&rarr;</span>{" "}
          <span className="font-medium">{to}</span>
        </>
      )}
    </p>
    );
  };
  return (
    <li className="rounded-control border border-border p-3 text-sm">
      <p className="m-0 font-semibold">{change.name}</p>
      <p className="m-0 text-xs text-muted-foreground">{change.category ?? t("preview.googleList")}</p>
      {field("price", t("services.panel.price"))}
      {field("description", t("sections.Description"))}
    </li>
  );
}
