"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { reports_definitions_create, reports_definitions_update } from "../../app/_generated/actions";
import { buttonPair } from "../../lib/theme/color";
import { commentCount, definitionInput, type EditorState } from "../../lib/reports";
import { Badge, ErrorText, buttonClass, inputClass, secondaryButtonClass } from "../ui";

type Opt = { id: string; workspaceId: string; label: string };
const HEX = /^#[0-9a-fA-F]{6}$/;
// The agency colour is data: pick the text colour that stays readable on it (WCAG 1.4.3).
const bannerStyle = (colour: string) => {
  const { bg, fg } = buttonPair(colour);
  return { background: bg, color: fg };
};
const field = "flex flex-col gap-1 text-sm font-medium text-foreground";
const box = "flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card";

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className={box}>
      <legend className="float-left mb-1 font-display text-base font-bold text-foreground">{legend}</legend>
      <div className="clear-both flex flex-col gap-3">{children}</div>
    </fieldset>
  );
}

export function ReportEditor(p: {
  mode: "new" | "edit";
  id?: string;
  initial: EditorState;
  workspaces: { id: string; name: string }[];
  groups: Opt[];
  locations: Opt[];
  emailOn: boolean;
  scheduleNote: string;
  /** Price and "AI is off" lines for the summary option; staff-only text, so it comes in as a prop. */
  summaryNotes: string[];
  groupDeleted: boolean;
  defaultColour: string;
  preview: { periodLabel: string; workspaceName: string; kpis: { label: string; value: string; delta: string }[]; keywords: { text: string; users: string }[] };
}) {
  const t = useTranslations("reports");
  const router = useRouter();
  const [s, setS] = useState<EditorState>(p.initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) => setS((x) => ({ ...x, [k]: v }));
  const groups = p.groups.filter((g) => g.workspaceId === s.workspaceId);
  const locs = p.locations.filter((l) => l.workspaceId === s.workspaceId);

  async function save() {
    setError(null);
    const built = definitionInput(s, t);
    if (!built.ok) return setError(built.error);
    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- update input has no workspaceId or kind
    const { workspaceId: _workspaceId, kind: _kind, ...rest } = built.input;
    const r = p.mode === "new" || !p.id ? await reports_definitions_create(built.input) : await reports_definitions_update({ id: p.id, ...rest });
    setSaving(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.push("/reports");
    router.refresh();
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <form aria-label={t("reportDefinition")} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Group legend={t("groupReportType")}>
          <label className="flex items-start gap-2">
            <input type="radio" name="report-type" checked={s.kind === "performance"} disabled={p.mode === "edit"} onChange={() => set("kind", "performance")} />
            <span className="flex flex-col"><span className="font-semibold">{t("performanceReport")}</span><span className="text-sm text-muted-foreground">{t("performanceReportHint")}</span></span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="report-type" checked={s.kind === "reviews"} disabled={p.mode === "edit"} onChange={() => set("kind", "reviews")} />
            <span className="flex flex-col"><span className="font-semibold">{t("reviewReport")}</span><span className="text-sm text-muted-foreground">{t("reviewReportHint")}</span></span>
          </label>
          {p.mode === "edit" && <p className="text-xs text-muted-foreground">{t("typeLocked")}</p>}
        </Group>

        <section aria-label={t("sectionName")} className={box}>
          <h2 className="font-display text-base font-bold">{t("sectionName")}</h2>
          {p.mode === "new" && p.workspaces.length > 1 && (
            <label className={field}>
              {t("client")}
              <select value={s.workspaceId} onChange={(e) => setS((x) => ({ ...x, workspaceId: e.target.value, groupId: "", locationIds: [] }))} className={inputClass}>
                {p.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
          )}
          <label className={field}>
            {t("reportName")}
            <input value={s.name} maxLength={120} onChange={(e) => set("name", e.target.value)} className={inputClass} />
          </label>
        </section>

        <Group legend={t("groupCovers")}>
          {p.groupDeleted && <p role="alert" className="text-sm text-bad">{t("groupDeletedAlert")}</p>}
          <label className="flex items-center gap-2"><input type="radio" name="scope" checked={s.scope === "workspace"} onChange={() => set("scope", "workspace")} />{t("wholeClient")}</label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2"><input type="radio" name="scope" checked={s.scope === "group"} onChange={() => set("scope", "group")} />{t("aGroup")}</label>
            <Badge tone="info">{t("newBadge")}</Badge>
            <label className={field}>
              {t("group")}
              <select disabled={s.scope !== "group"} value={s.groupId} onChange={(e) => set("groupId", e.target.value)} className={inputClass}>
                <option value="">{t("pickGroup")}</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2"><input type="radio" name="scope" checked={s.scope === "locations"} onChange={() => set("scope", "locations")} />{t("chosenLocations")}</label>
            <div className="grid gap-1 pl-6 sm:grid-cols-2">
              {locs.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={s.scope !== "locations"}
                    checked={s.locationIds.includes(l.id)}
                    onChange={(e) => set("locationIds", e.target.checked ? [...s.locationIds, l.id] : s.locationIds.filter((x) => x !== l.id))}
                  />
                  {l.label}
                </label>
              ))}
              {s.scope !== "locations" && <span className="text-xs text-muted-foreground">{t("chooseLocationsHint")}</span>}
            </div>
          </div>
        </Group>

        <Group legend={t("groupPeriod")}>
          <label className="flex items-center gap-2"><input type="radio" name="period" checked={s.period === "last_month"} onChange={() => set("period", "last_month")} />{t("lastMonth")}</label>
          <label className="flex items-center gap-2"><input type="radio" name="period" checked={s.period === "last_30_days"} onChange={() => set("period", "last_30_days")} />{t("last30Days")}</label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2"><input type="radio" name="period" checked={s.period === "custom"} onChange={() => set("period", "custom")} />{t("custom")}</label>
            <label className={field}>{t("customFrom")}<input type="date" disabled={s.period !== "custom"} value={s.customFrom} onChange={(e) => set("customFrom", e.target.value)} className={inputClass} /></label>
            <label className={field}>{t("customTo")}<input type="date" disabled={s.period !== "custom"} value={s.customTo} onChange={(e) => set("customTo", e.target.value)} className={inputClass} /></label>
          </div>
        </Group>

        <section aria-label={t("sectionLanguage")} className={box}>
          <h2 className="font-display text-base font-bold">{t("sectionLanguage")}</h2>
          <label className={field}>
            {t("sectionLanguage")}
            <select value={s.language} onChange={(e) => set("language", e.target.value as EditorState["language"])} className={inputClass}>
              <option value="en">{t("languageEn")}</option>
              <option value="es">{t("languageEs")}</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">{t("languageHint")}</p>
        </section>

        <section aria-label={t("sectionComment")} className={box}>
          <h2 className="font-display text-base font-bold">{t("sectionComment")}</h2>
          <label className={field}>
            {t("commentLabel")}
            <textarea rows={4} value={s.comment} onChange={(e) => set("comment", e.target.value)} className={inputClass} />
          </label>
          <p className={`text-xs ${s.comment.trim().length > 500 ? "text-bad" : "text-muted-foreground"}`}>{commentCount(s.comment, t)}</p>
        </section>

        <section aria-label={t("sectionSummary")} className={box}>
          <h2 className="font-display text-base font-bold">{t("sectionSummary")}</h2>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={s.aiSummary} onChange={(e) => set("aiSummary", e.target.checked)} />
            <span className="flex flex-col"><span className="font-semibold">{t("aiSummaryLabel")}</span><span className="text-sm text-muted-foreground">{t("aiSummaryHint")}</span></span>
          </label>
          {p.summaryNotes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
        </section>

        <section aria-label={t("sectionBranding")} className={box}>
          <h2 className="font-display text-base font-bold">{t("sectionBranding")}</h2>
          <div className="flex flex-wrap gap-3">
            <label className={field}>{t("agencyName")}<input value={s.agencyName} maxLength={80} onChange={(e) => set("agencyName", e.target.value)} className={inputClass} /></label>
            <label className={field}>
              {t("colour")}
              <span className="flex items-center gap-2">
                <span aria-hidden className="size-6 rounded border border-border" style={HEX.test(s.colour) ? { background: s.colour } : undefined} />
                <input value={s.colour} placeholder="#1F4E79" onChange={(e) => set("colour", e.target.value)} className={inputClass} />
              </span>
            </label>
          </div>
          {/* Default copy: the PDF draws no logo. */}
          <p className="text-xs text-muted-foreground">{t("brandingNote")}</p>
        </section>

        <section aria-label={t("sectionEmail")} className={box}>
          <h2 className="font-display text-base font-bold">{t("sectionEmail")}</h2>
          <label className={field}>
            {t("emailSchedule")}
            <select value={s.schedule} onChange={(e) => set("schedule", e.target.value as EditorState["schedule"])} className={inputClass}>
              <option value="none">{t("scheduleOff")}</option>
              <option value="monthly">{t("scheduleMonthly")}</option>
            </select>
          </label>
          <label className={field}>{t("recipients")}<input value={s.recipients} onChange={(e) => set("recipients", e.target.value)} className={inputClass} /></label>
          {!p.emailOn && (
            <div role="note" className="flex flex-wrap items-center gap-2 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
              <Badge tone="warning">{t("notLive")}</Badge>
              {/* Default copy. */}
              <span>{t("emailNotSetUp")}</span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{p.scheduleNote}</p>
        </section>

        <ErrorText message={error} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className={buttonClass}>{p.mode === "new" ? t("createReport") : t("saveChanges")}</button>
          <Link href="/reports" className={secondaryButtonClass}>{t("cancel")}</Link>
          <span className="text-sm text-muted-foreground">{t("savingNote")}</span>
        </div>
      </form>

      <aside aria-label={t("preview")} className="flex h-fit flex-col gap-3 rounded-panel border border-border bg-muted p-(--panel-p)">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold">{t("preview")}</h2>
          <span className="text-xs text-muted-foreground">{t("previewNotToScale")}</span>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-card text-sm">
          <div className="px-4 py-3 font-display font-bold" style={bannerStyle(HEX.test(s.colour) ? s.colour : p.defaultColour)}>
            {s.agencyName.trim() || "OpenGMB"}
          </div>
          <div className="flex flex-col gap-3 p-4">
            <div>
              <div className="font-bold">{s.name.trim() || t("previewFallbackName")} · {p.preview.periodLabel}</div>
              <div className="text-xs text-muted-foreground">{p.workspaces.find((w) => w.id === s.workspaceId)?.name ?? p.preview.workspaceName}</div>
            </div>
            {s.kind === "reviews" ? (
              <>
                <ul aria-label={t("previewContents")} className="list-disc pl-5">
                  <li>{t("previewReviewItem1")}</li>
                  <li>{t("previewReviewItem2")}</li>
                  <li>{t("previewReviewItem3")}</li>
                  <li>{t("previewReviewItem4")}</li>
                </ul>
                <p className="text-xs text-muted-foreground">{t("previewNumbersLater")}</p>
              </>
            ) : s.workspaceId !== p.initial.workspaceId ? (
              <p className="text-xs text-muted-foreground">{t("previewNumbersLater")}</p>
            ) : (
              <>
              <div role="table" aria-label={t("previewFigures")} className="flex flex-col gap-1">
                {p.preview.kpis.map((k) => (
                  <div role="row" key={k.label} className="flex justify-between gap-2">
                    <span role="cell" className="text-muted-foreground">{k.label}</span>
                    <span role="cell"><strong>{k.value}</strong> <span className="text-xs text-muted-foreground">{k.delta}</span></span>
                  </div>
                ))}
              </div>
              <div>
                <div className="font-semibold">{t("topKeywords")}</div>
                <ul>{p.preview.keywords.map((w) => <li key={w.text} className="flex justify-between"><span>{w.text}</span><strong>{w.users}</strong></li>)}</ul>
              </div>
              </>
            )}
            {s.aiSummary && <p className="text-xs italic text-muted-foreground">{t("previewSummary")}</p>}
            {s.comment.trim() && <p className="whitespace-pre-line text-foreground">{s.comment.trim()}</p>}
            <div className="text-xs text-muted-foreground">{t("previewNoReviewText")}</div>
          </div>
        </div>
      </aside>
    </div>
  );
}
