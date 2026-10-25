"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { statusWords } from "@/lib/labels";
import { useEffect, useState } from "react";
import { profile_get, profile_preview, profile_propose } from "../app/_generated/actions";
import { approvalsHref, itemKey } from "../lib/approvals";
import {
  addServiceNames,
  anyField,
  BULK_FIELDS,
  buildAddCategories,
  buildAddServices,
  buildFields,
  buildSkipUnoffered,
  canPropose,
  categoriesAfter,
  changedDays,
  emptyForm,
  formProblemList,
  previewRow,
  replaceWarning,
  serviceCategory,
  type BulkForm,
  type BulkGroup,
  type BulkLoc,
  type DayRow,
} from "../lib/bulk-edit";
import { copyNotes, sendLists } from "../lib/copy-services";
import { failureLabel } from "../lib/failure-labels";
import { categoryLabel } from "@/lib/labels";
import { LocationPicker } from "./location-picker";
import { AddCategoriesPicker, CategoryPicker, SingleCategoryPicker } from "./profile/category-picker";
import { Pill } from "./page-parts";
import { runCall } from "./post-card";
import {
  AttributesEditor,
  SpecialHoursEditor,
  attributeFromRow,
  specialFromRows,
  type AttrRow,
  type PreviewLoc,
  type SpecialRow,
} from "./profile-forms";
import { Violations } from "./reply-panel";
import { buttonClass, ErrorText, inputClass, Panel, secondaryButtonClass } from "./ui";

const th = "px-3 py-2 text-xs font-semibold text-muted-foreground";
const td = "px-3 py-2 align-top";
const small = "min-h-8 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

// Used until Google's own region and language for the first picked location are read.
const DEFAULT_LOCALE = { regionCode: "US", languageCode: "en" };

const RESULT_KEY = { Ready: "resultReady", "no change": "resultNoChange", error: "resultError", blocked: "resultBlocked" } as const;

export function BulkProfileEdit({
  workspaceId,
  locations,
  groups,
  searchMinChars,
}: {
  workspaceId: string;
  locations: BulkLoc[];
  groups: BulkGroup[];
  searchMinChars: number;
}) {
  const t = useTranslations("locations");
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState<BulkForm>(emptyForm);
  const [special, setSpecial] = useState<SpecialRow[]>([]);
  const [attrs, setAttrs] = useState<AttrRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewLoc[] | null>(null);
  const [proposed, setProposed] = useState<{ id: string; status: string } | null>(null);
  // Errors show only for a field that has been touched (or after Preview was tried).
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  // Bulk edit has no single location: the category search uses the first picked one's region and language.
  const [locale, setLocale] = useState<{ for: string; regionCode: string; languageCode: string; error?: string } | null>(null);
  const searchLocation = picked[0] ?? null;
  useEffect(() => {
    if (!searchLocation) return;
    let stop = false;
    void (async () => {
      const r = await runCall<{ display: { regionCode: string; languageCode: string; categoryNames: Record<string, string> } }>(() =>
        profile_get({ locationId: searchLocation }),
      );
      if (stop) return;
      if ("error" in r) return setLocale({ for: searchLocation, ...DEFAULT_LOCALE, error: r.error });
      const { regionCode, languageCode, categoryNames } = r.data.display;
      setLocale({ for: searchLocation, regionCode, languageCode });
      setNames((n) => ({ ...categoryNames, ...n }));
    })();
    return () => {
      stop = true;
    };
  }, [searchLocation]);
  const mark = (...keys: string[]) => setTouched((t) => (keys.every((k) => t.has(k)) ? t : new Set([...t, ...keys])));

  // Any edit invalidates the preview: what is proposed is always what was previewed.
  const touch = () => {
    setPreview(null);
    setProposed(null);
  };
  const edit = (patch: Partial<BulkForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    touch();
  };
  const pick = (ids: string[]) => {
    setPicked(ids);
    touch();
  };
  const built = () => ({
    specialHours: specialFromRows(special),
    attributes: Object.fromEntries(
      attrs.filter((a) => a.name.trim()).map((a) => [a.name.trim(), a.remove ? null : attributeFromRow(a)]),
    ),
  });

  const problems = formProblemList(form);
  const ready = picked.length > 0 && anyField(form);
  const shown = (key: string) => {
    const m = problems.filter((p) => p.key === key && touched.has(key)).map((p) => p.message);
    return m.length > 0 ? m.join(". ") : null;
  };
  const fieldError = (key: string) => {
    const m = shown(key);
    return m ? <p id={`err-${key}`} role="alert" className="text-sm font-medium text-bad">{m}</p> : null;
  };
  const bad = (key: string) => ({ "aria-invalid": shown(key) ? true : undefined, "aria-describedby": shown(key) ? `err-${key}` : undefined });
  const pickerLocale = searchLocation && locale?.for === searchLocation ? locale : null;
  const pickerProps = (key: string) =>
    pickerLocale && searchLocation
      ? {
          locationId: searchLocation,
          regionCode: pickerLocale.regionCode,
          languageCode: pickerLocale.languageCode,
          minChars: searchMinChars,
          names,
          onLearn: (o: { name: string; displayName: string }) => setNames((n) => ({ ...n, [o.name]: o.displayName })),
          onTouch: () => mark(key),
          describedBy: shown(key) ? `err-${key}` : undefined,
        }
      : null;
  const pickerGate = (key: string, render: (props: NonNullable<ReturnType<typeof pickerProps>>) => React.ReactNode) => {
    if (!searchLocation) return <p className="text-xs text-muted-foreground">{t("pickLocationAbove")}</p>;
    const props = pickerProps(key);
    if (!props) return <p role="status" className="text-xs text-muted-foreground">{t("readingCategoryList")}</p>;
    return render(props);
  };

  function tryPreview() {
    if (problems.length > 0) return mark(...problems.map((p) => p.key));
    void doPreview();
  }

  async function doPreview() {
    setBusy(true);
    setError(null);
    setProposed(null);
    setPreview(null);
    const r = await runCall<{ locations: PreviewLoc[] }>(() =>
      profile_preview({
        locationIds: picked,
        fields: buildFields(form, built()),
        addServiceItems: buildAddServices(form),
        addCategories: buildAddCategories(form),
        skipUnofferedServices: buildSkipUnoffered(form),
      }),
    );
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setPreview(r.data.locations);
  }

  async function doPropose() {
    if (!preview) return;
    const readable = preview.filter((l) => !l.error);
    setBusy(true);
    setError(null);
    const r = await runCall<{ changeSet: { id: string; status: string } }>(() =>
      profile_propose({
        workspaceId,
        locationIds: readable.map((l) => l.locationId),
        fields: buildFields(form, built()),
        addServiceItems: buildAddServices(form),
        addCategories: buildAddCategories(form),
        skipUnofferedServices: buildSkipUnoffered(form),
        serviceAddSend: sendLists(readable),
        snapshots: readable.map((l) => ({ locationId: l.locationId, current: l.current })),
      }),
    );
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setProposed(r.data.changeSet);
  }

  const setDay = (i: number, patch: Partial<DayRow>) =>
    edit({ week: form.week.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const changed = new Set(changedDays(form.week));
  const rows = preview?.map(previewRow) ?? [];
  const unreadable = rows.filter((r) => r.result === "error");
  const losses =
    form.use.serviceItems && form.services.mode === "replace"
      ? (preview ?? []).flatMap((l) => {
          const w = replaceWarning(l.locationName, l.current, serviceCategory(form));
          return w ? [w] : [];
        })
      : [];

  const readableRows = (preview ?? []).filter((l) => !l.error);
  const catLines =
    form.use.categories && form.categories.mode === "add"
      ? readableRows.map((l) => {
          const c = categoriesAfter(l.changes);
          return { id: l.locationId, name: l.locationName, text: c ? c.map((id) => categoryLabel(id, names)).join(", ") : null };
        })
      : [];
  const serviceNames = addServiceNames(form);
  const svcNotes =
    form.use.serviceItems && form.services.mode === "add"
      ? readableRows.flatMap((l) => {
          const n = copyNotes(serviceNames, l.serviceAdd);
          return n ? [{ id: l.locationId, name: l.locationName, ...n }] : [];
        })
      : [];

  return (
    <div className="flex flex-col gap-5">
      <Panel title={t("panelLocations")}>
        <LocationPicker locations={locations} groups={groups} picked={picked} onPick={pick} />
      </Panel>

      <Panel title={t("panelFields")}>
        <section aria-label={t("fieldsLabel")} className="flex flex-col gap-4">
          {BULK_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={form.use[f.key]} onChange={(e) => edit({ use: { ...form.use, [f.key]: e.target.checked } })} />
                {t(`bf_${f.key}`)}
              </label>
              {form.use[f.key] && (
                <div className="ml-6 flex flex-col gap-2">
                  {f.key === "regularHours" &&
                    form.week.map((d, i) => (
                      <div key={d.day} className={`flex flex-wrap items-center gap-2 rounded-md px-2 py-1 ${changed.has(d.day) ? "bg-info-bg" : ""}`}>
                        <span className={`w-24 text-sm ${changed.has(d.day) ? "font-bold" : ""}`}>{t(`day_${d.day}`)}</span>
                        <input aria-label={t("dayOpens", { day: t(`day_${d.day}`) })} value={d.open} disabled={d.closed} size={6} className={small}
                          onBlur={() => mark("regularHours")} onChange={(e) => setDay(i, { open: e.target.value })} />
                        <span aria-hidden>{t("to")}</span>
                        <input aria-label={t("dayCloses", { day: t(`day_${d.day}`) })} value={d.close} disabled={d.closed} size={6} className={small}
                          onBlur={() => mark("regularHours")} onChange={(e) => setDay(i, { close: e.target.value })} />
                        <label className="flex items-center gap-1 text-sm">
                          <input type="checkbox" checked={d.closed} onChange={(e) => setDay(i, { closed: e.target.checked })} />
                          {t("closed")}
                        </label>
                        {changed.has(d.day) && <Pill tone="info">{t("changedPill")}</Pill>}
                      </div>
                    ))}
                  {f.key === "regularHours" && fieldError("regularHours")}
                  {f.key === "specialHours" && <SpecialHoursEditor rows={special} onChange={(r) => { setSpecial(r); touch(); }} />}
                  {f.key === "attributes" && <AttributesEditor rows={attrs} onChange={(r) => { setAttrs(r); touch(); }} />}
                  {f.key === "description" && (
                    <>
                      <textarea aria-label={t("descriptionAria")} rows={4} className={`${inputClass} py-2`} value={form.description} {...bad("description")}
                        onBlur={() => mark("description")} onChange={(e) => edit({ description: e.target.value })} />
                      {fieldError("description")}
                    </>
                  )}
                  {f.key === "websiteUri" && (
                    <input aria-label={t("websiteAria")} placeholder="https://" className={inputClass} value={form.website}
                      onChange={(e) => edit({ website: e.target.value })} />
                  )}
                  {f.key === "title" && (
                    <>
                      <input aria-label={t("titleAria")} className={inputClass} value={form.title} {...bad("title")}
                        onBlur={() => mark("title")} onChange={(e) => edit({ title: e.target.value })} />
                      {fieldError("title")}
                    </>
                  )}
                  {f.key === "categories" && (
                    <>
                      <fieldset className="flex flex-col gap-1 text-sm">
                        <legend className="sr-only">{t("categoriesMode")}</legend>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="categories-mode" checked={form.categories.mode === "add"}
                            onChange={() => edit({ categories: { ...form.categories, mode: "add" } })} />
                          {t("catAdd")}
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="categories-mode" checked={form.categories.mode === "replace"}
                            onChange={() => edit({ categories: { ...form.categories, mode: "replace" } })} />
                          {t("catReplace")}
                        </label>
                      </fieldset>
                      {form.categories.mode === "replace" && (
                        <p role="note" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
                          {t("catReplaceNote")}
                        </p>
                      )}
                      {pickerGate("categories", (props) =>
                        form.categories.mode === "add" ? (
                          <AddCategoriesPicker {...props} label={t("categoriesToAdd")} chosen={form.categories.add}
                            onChange={(add) => edit({ categories: { ...form.categories, add } })} />
                        ) : (
                          <CategoryPicker locationId={props.locationId} regionCode={props.regionCode} languageCode={props.languageCode}
                            minChars={props.minChars} names={names} primary={form.categories.primary} additional={form.categories.additional}
                            onChange={(primary, additional) => {
                              edit({ categories: { ...form.categories, primary, additional } });
                              mark("categories");
                            }} />
                        ),
                      )}
                      {fieldError("categories")}
                      {pickerLocale?.error && (
                        <p className="text-xs text-muted-foreground">
                          {t("regionError", { error: pickerLocale.error })}
                        </p>
                      )}
                    </>
                  )}
                  {f.key === "serviceItems" && (
                    <>
                      <fieldset className="flex flex-col gap-1 text-sm">
                        <legend className="sr-only">{t("servicesMode")}</legend>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="services-mode" checked={form.services.mode === "add"}
                            onChange={() => edit({ services: { ...form.services, mode: "add" } })} />
                          {t("svcAdd")}
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="services-mode" checked={form.services.mode === "replace"}
                            onChange={() => edit({ services: { ...form.services, mode: "replace" } })} />
                          {t("svcReplace")}
                        </label>
                      </fieldset>
                      {form.services.mode === "replace" && (
                        <p role="note" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
                          {t("svcReplaceNote")}
                        </p>
                      )}
                      <label className="flex flex-col gap-1 text-sm">
                        {form.services.mode === "add" ? t("svcLinesAdd") : t("svcLinesReplace")}
                        <textarea rows={3} className={`${inputClass} py-2`} value={form.services.lines} {...bad("services")}
                          onBlur={() => mark("services")} onChange={(e) => edit({ services: { ...form.services, lines: e.target.value } })} />
                      </label>
                      {fieldError("services")}
                      {pickerGate("serviceCategory", (props) => (
                        <SingleCategoryPicker {...props} label={t("svcCategory")} value={form.services.category}
                          onChange={(category) => edit({ services: { ...form.services, category } })} />
                      ))}
                      {fieldError("serviceCategory")}
                      <p className="text-xs text-muted-foreground">
                        {form.services.mode === "add"
                          ? t("svcNoteAdd")
                          : form.use.categories && form.categories.mode === "replace"
                            ? t("svcNoteReplaceEmpty")
                            : t("svcNoteDefault")}
                      </p>
                    </>
                  )}
                  {f.key === "serviceArea" && (
                    <>
                      <select aria-label={t("areaTypeAria")} className={inputClass} value={form.area.type}
                        onChange={(e) => edit({ area: { ...form.area, type: e.target.value as BulkForm["area"]["type"] } })}>
                        <option value="">{t("areaNone")}</option>
                        <option value="CUSTOMER_LOCATION_ONLY">{t("areaCustomer")}</option>
                        <option value="CUSTOMER_AND_BUSINESS_LOCATION">{t("areaBoth")}</option>
                      </select>
                      <textarea aria-label={t("areaPlacesAria")} rows={3} className={`${inputClass} py-2`} value={form.area.places}
                        onChange={(e) => edit({ area: { ...form.area, places: e.target.value } })} />
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Pill tone="warn">{t("notLive")}</Pill> {t("placeSearchNote")}
                      </span>
                    </>
                  )}
                  {f.key === "openingDate" && (
                    <>
                      <input aria-label={t("openingDateAria")} placeholder="YYYY-MM-DD" className={inputClass} {...bad("openingDate")}
                        value={form.openingDate} onBlur={() => mark("openingDate")} onChange={(e) => edit({ openingDate: e.target.value })} />
                      {fieldError("openingDate")}
                    </>
                  )}
                  {f.key === "phoneNumbers" && (
                    <>
                      <input aria-label={t("primaryPhoneAria")} className={inputClass} value={form.phones.primary} {...bad("phoneNumbers")}
                        onBlur={() => mark("phoneNumbers")} onChange={(e) => edit({ phones: { ...form.phones, primary: e.target.value } })} />
                      {fieldError("phoneNumbers")}
                      <input aria-label={t("morePhonesAria")} className={inputClass} value={form.phones.more}
                        onChange={(e) => edit({ phones: { ...form.phones, more: e.target.value } })} />
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("tickNote")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButtonClass} disabled={busy || !ready} onClick={tryPreview}>{t("previewChanges")}</button>
            <button type="button" className={buttonClass} disabled={busy || !canPropose(preview) || proposed !== null} onClick={doPropose}>
              {t("proposeForApproval")}
            </button>
          </div>
          {!ready && (
            <p className="text-xs text-muted-foreground">{t("tickAtLeast")}</p>
          )}
          <ErrorText message={error} />
        </section>
      </Panel>

      {busy && !preview && !proposed && (
        <p role="status" className="rounded-control border border-info-border bg-info-bg px-3 py-2 text-[13px] text-info">
          {t("readingProfiles", { count: picked.length })}
        </p>
      )}
      {preview && (
        <section aria-label={t("previewHeading")} className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold">{t("previewHeading")}</h2>
          {unreadable.length > 0 && (
            <p className="text-[13px]">
              <strong>{t("previewCouldNotRead", { count: unreadable.length })}</strong>{" "}
              <span className="text-muted-foreground">{t("otherLocationsDiff")}</span>
            </p>
          )}
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-muted">
                <tr>
                  {[t("thLocation"), t("thChanges"), "updateMask", t("thCheck"), t("thResult")].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.locationId} className="border-t border-border">
                    <td className={`${td} font-semibold`}>{r.name}</td>
                    <td className={td}>
                      {r.error ? (
                        <span className="text-bad"><span className="font-mono">{r.error}</span>: {failureLabel(r.error)}</span>
                      ) : r.result === "no change" ? t("alreadyMatches") : r.changes}
                    </td>
                    <td className={`${td} font-mono text-xs`}>{r.mask}</td>
                    <td className={`${td} ${r.check === "No guardrail violations." ? "text-good" : "text-muted-foreground"}`}>{r.check === "No guardrail violations." ? t("noViolations") : r.check}</td>
                    <td className={td}><Pill tone={r.tone}>{t(RESULT_KEY[r.result])}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {losses.length > 0 && (
            <div role="alert" className="flex flex-col gap-1 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
              <strong>{t("replaceLossHeading")}</strong>
              <ul className="list-disc pl-5">{losses.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {catLines.length > 0 && (
            <div aria-label={t("categoriesAfter")} className="flex flex-col gap-1 text-[13px]">
              <strong>{t("categoriesEndUp")}</strong>
              <ul className="list-disc pl-5">
                {catLines.map((c) => (
                  <li key={c.id}><span className="font-semibold">{c.name}:</span> {c.text ?? t("alreadyHasCategories")}</li>
                ))}
              </ul>
            </div>
          )}
          {svcNotes.length > 0 && (
            <div aria-label={t("servicesToAdd")} className="flex flex-col gap-1 text-[13px]">
              <strong>{t("servicesToAdd")}</strong>
              <ul className="list-disc pl-5">
                {svcNotes.map((n) => (
                  <li key={n.id}>
                    <span className="font-semibold">{n.name}:</span> {t("addedToAdd", { added: n.added })}
                    {n.unchanged ? `, ${n.unchanged}` : ""}
                    {n.flags.map((fl) => <span key={fl} className="block text-warn">{fl}</span>)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview
            .filter((l) => l.guardrail && l.guardrail.violations.length > 0)
            .map((l) => (
              <div key={l.locationId} className="flex flex-col gap-1">
                <strong className="text-sm">{l.locationName}</strong>
                <Violations result={l.guardrail!} />
                {!l.guardrail!.ok && <p className="text-xs text-muted-foreground">{t("fixOrUntick", { name: l.locationName })}</p>}
              </div>
            ))}
        </section>
      )}
      {proposed && (
        <p aria-live="polite" className="rounded-control border border-good-border bg-good-bg px-3 py-2 text-[13px] text-good">
          {t("changeSetRecorded", { status: statusWords(proposed.status) })}{" "}
          <Link href={approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: proposed.id }) })}
            className="font-bold text-brand-text underline underline-offset-2">
            {t("reviewInApprovals")}
          </Link>
        </p>
      )}
    </div>
  );
}
