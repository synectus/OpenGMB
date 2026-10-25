"use client";
import type { profilePreview } from "@opengmb/core";
import { useTranslations } from "next-intl";
import { Violations } from "./reply-panel";
import {
  attributeFromRow,
  dateText,
  rowsFromAttributes,
  rowsFromSpecial,
  specialFromRows,
  type AttrRow,
  type SpecialRow,
} from "../lib/profile-editor";
export { attributeFromRow, dateText, rowsFromAttributes, rowsFromSpecial, specialFromRows };
export type { AttrRow, SpecialRow };

export type PreviewLoc = Awaited<
  ReturnType<(typeof profilePreview)["handler"]>
>["locations"][number];
export type Values = { fields: Record<string, unknown>; attributes: Record<string, unknown> };
export const field = "rounded border border-input px-2 py-1 text-sm";
export const small = "rounded border border-input px-3 py-1 text-sm disabled:opacity-50";

export const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

// ---------------------------------------------------------------- hours

export type HourRow = { day: string; open: string; close: string };
function toTod(s: string) {
  const [h, m] = s.split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

/** Rows to a regularHours value. The editor writes same-day periods (open and close on one day). */
export function hoursFromRows(rows: HourRow[]) {
  return rows.length === 0
    ? null
    : {
        periods: rows.map((r) => ({
          openDay: r.day,
          openTime: toTod(r.open),
          closeDay: r.day,
          closeTime: toTod(r.close),
        })),
      };
}

export function HoursEditor({
  rows,
  onChange,
}: {
  rows: HourRow[];
  onChange: (rows: HourRow[]) => void;
}) {
  const set = (i: number, patch: Partial<HourRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        One row per opening period (open and close on the same day; 24:00 closes at midnight).
        Several rows for a day means a split day. No rows clears the hours.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Day ${i + 1}`}
            className={field}
            value={r.day}
            onChange={(e) => set(i, { day: e.target.value })}
          >
            {DAYS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <input
            aria-label={`Opens ${i + 1}`}
            className={field}
            value={r.open}
            onChange={(e) => set(i, { open: e.target.value })}
            size={6}
          />
          <span aria-hidden>to</span>
          <input
            aria-label={`Closes ${i + 1}`}
            className={field}
            value={r.close}
            onChange={(e) => set(i, { close: e.target.value })}
            size={6}
          />
          <button
            type="button"
            className={small}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className={small}
          onClick={() => onChange([...rows, { day: "MONDAY", open: "09:00", close: "17:00" }])}
        >
          Add period
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- special hours

export function SpecialHoursEditor({
  rows,
  onChange,
}: {
  rows: SpecialRow[];
  onChange: (rows: SpecialRow[]) => void;
}) {
  const t = useTranslations("profile");
  const set = (i: number, patch: Partial<SpecialRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t("forms.specialHint")}</p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            aria-label={t("forms.specialDate", { n: i + 1 })}
            className={field}
            placeholder="2026-12-25"
            value={r.date}
            onChange={(e) => set(i, { date: e.target.value })}
            size={11}
          />
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={r.closed}
              onChange={(e) => set(i, { closed: e.target.checked })}
            />
            {t("closed")}
          </label>
          {!r.closed && (
            <>
              <input
                aria-label={t("forms.specialOpens", { n: i + 1 })}
                className={field}
                value={r.open}
                onChange={(e) => set(i, { open: e.target.value })}
                size={6}
              />
              <span aria-hidden>{t("hours.to")}</span>
              <input
                aria-label={t("forms.specialCloses", { n: i + 1 })}
                className={field}
                value={r.close}
                onChange={(e) => set(i, { close: e.target.value })}
                size={6}
              />
            </>
          )}
          <button
            type="button"
            className={small}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            {t("remove")}
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className={small}
          onClick={() =>
            onChange([...rows, { date: "", closed: true, open: "09:00", close: "13:00" }])
          }
        >
          {t("forms.addSpecialDay")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- attributes

export function AttributesEditor({
  rows,
  onChange,
}: {
  rows: AttrRow[];
  onChange: (rows: AttrRow[]) => void;
}) {
  const t = useTranslations("profile");
  const set = (i: number, patch: Partial<AttrRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t("forms.attributesHint")}</p>
      {rows.map((r, i) => (
        <div
          key={i}
          className={`flex flex-wrap items-center gap-2 ${r.remove ? "opacity-50" : ""}`}
        >
          <input
            aria-label={t("forms.attribute", { n: i + 1 })}
            className={field}
            value={r.name}
            placeholder="attributes/has_wifi"
            onChange={(e) => set(i, { name: e.target.value })}
            size={28}
          />
          <select
            aria-label={t("forms.attributeType", { n: i + 1 })}
            className={field}
            value={r.kind}
            onChange={(e) => set(i, { kind: e.target.value as AttrRow["kind"] })}
          >
            <option value="values">{t("forms.valueOption")}</option>
            <option value="uri">URL</option>
          </select>
          <input
            aria-label={t("forms.attributeValue", { n: i + 1 })}
            className={field}
            value={r.text}
            onChange={(e) => set(i, { text: e.target.value })}
            size={28}
          />
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={r.remove}
              onChange={(e) => set(i, { remove: e.target.checked })}
            />
            {t("forms.delete")}
          </label>
        </div>
      ))}
      <div>
        <button
          type="button"
          className={small}
          onClick={() =>
            onChange([...rows, { name: "", kind: "values", text: "true", remove: false }])
          }
        >
          {t("forms.addAttribute")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- preview table

const show = (v: unknown, notSet: string) => (v === null || v === undefined ? notSet : JSON.stringify(v));

/** Per-location diff table plus guardrails; shared by the editor and the bulk page. */
export function PreviewTable({
  locations,
  names,
}: {
  locations: PreviewLoc[];
  names: Record<string, string>;
}) {
  const t = useTranslations("profile");
  return (
    <div className="flex flex-col gap-4" aria-label={t("preview.sectionLabel")}>
      {locations.map((l) => (
        <section
          key={l.locationId}
          className="flex flex-col gap-2 rounded border border-input p-3"
        >
          <h3 className="font-medium">{names[l.locationId] ?? l.locationName}</h3>
          {l.error ? (
            <p role="alert" className="text-sm text-bad">
              {t("forms.couldNotRead", { error: l.error })}
            </p>
          ) : l.noChange ? (
            <p className="text-sm text-muted-foreground">{t("forms.nothingChanges")}</p>
          ) : (
            <>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="pr-2">{t("preview.field")}</th>
                    <th className="pr-2">{t("preview.now")}</th>
                    <th>{t("forms.new")}</th>
                  </tr>
                </thead>
                <tbody>
                  {l.changes.map((c) => (
                    <tr key={c.field} className="align-top">
                      <td className="pr-2 font-medium">{c.field}</td>
                      <td className="pr-2 break-all text-muted-foreground">{show(c.before, t("forms.notSet"))}</td>
                      <td className="break-all">{show(c.after, t("forms.notSet"))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground">
                {t("forms.updateMask")} {[...l.updateMask, ...l.attributeMask].join(", ")}
              </p>
              {l.guardrail && <Violations result={l.guardrail} />}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
