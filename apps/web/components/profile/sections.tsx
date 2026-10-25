"use client";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  AREA_TYPES,
  MAX_SPANS,
  addPlace,
  copyMondayToWeekdays,
  todText,
  setDayOpen,
  type Area,
  type DayRow,
  type Period,
  type ProfileForm,
  type SpecialRow,
} from "../../lib/profile-editor";
import { ErrorText, inputClass } from "../ui";
import { NotLiveBadge, fieldLabelClass, hintClass, usePhrase } from "./section";

const small =
  "inline-flex h-9 items-center rounded-control border border-input bg-card px-3 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const time = `${inputClass} w-20 tabular-nums`;
const chip =
  "inline-flex items-center gap-1 rounded-full border border-border bg-secondary py-0.5 pl-3 pr-1 text-sm text-secondary-foreground";
const chipX = "rounded-full p-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring";

export function HoursGrid({
  rows,
  kept,
  onChange,
}: {
  rows: DayRow[];
  kept: Period[];
  onChange: (rows: DayRow[]) => void;
}) {
  const t = useTranslations("profile");
  const update = (i: number, row: DayRow) => onChange(rows.map((r, j) => (j === i ? row : r)));
  const periodText = (p: Period) =>
    t("hours.period", {
      openDay: t(`days.${p.openDay}`),
      open: todText(p.openTime),
      close:
        p.closeDay === p.openDay ? todText(p.closeTime) : `${t(`days.${p.closeDay}`)} ${todText(p.closeTime)}`,
    });
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => {
        const day = t(`days.${r.day}`);
        return (
          <div key={r.day} className="flex flex-wrap items-center gap-3 border-b border-border py-2">
            <span className="w-24 text-sm font-semibold">{day}</span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={r.open}
                aria-label={t("hours.dayOpen", { day })}
                onChange={(e) => onChange(setDayOpen(rows, r.day, e.target.checked))}
              />
              {t("hours.open")}
            </label>
            {r.open ? (
              <div className="flex flex-wrap items-center gap-2">
                {r.spans.map((s, k) => {
                  const second = k > 0;
                  const setSpan = (patch: Partial<typeof s>) =>
                    update(i, { ...r, spans: r.spans.map((x, m) => (m === k ? { ...x, ...patch } : x)) });
                  return (
                    <span key={k} className="flex items-center gap-2">
                      <input
                        aria-label={t(second ? "hours.opensSecond" : "hours.opens", { day })}
                        className={time}
                        placeholder="HH:MM"
                        value={s.from}
                        onChange={(e) => setSpan({ from: e.target.value })}
                      />
                      <span aria-hidden>{t("hours.to")}</span>
                      <input
                        aria-label={t(second ? "hours.closesSecond" : "hours.closes", { day })}
                        className={time}
                        placeholder="HH:MM"
                        value={s.to}
                        onChange={(e) => setSpan({ to: e.target.value })}
                      />
                      {k > 0 && (
                        <button
                          type="button"
                          className={small}
                          aria-label={t("hours.removeSecond", { day })}
                          onClick={() => update(i, { ...r, spans: r.spans.filter((_, m) => m !== k) })}
                        >
                          {t("remove")}
                        </button>
                      )}
                    </span>
                  );
                })}
                {r.spans.length < MAX_SPANS && (
                  <button
                    type="button"
                    className={small}
                    aria-label={t("hours.addSecondLabel", { day })}
                    onClick={() => update(i, { ...r, spans: [...r.spans, { from: "13:00", to: "17:00" }] })}
                  >
                    {t("hours.addSecond")}
                  </button>
                )}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">{t("closed")}</span>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <button type="button" className={small} onClick={() => onChange(copyMondayToWeekdays(rows))}>
          {t("hours.copyMonday")}
        </button>
        <span className={hintClass}>{t("hours.timesHint")}</span>
      </div>
      {kept.length > 0 && (
        <p className={`${hintClass} pt-2`}>
          {t("hours.kept", { periods: kept.map(periodText).join("; ") })}
        </p>
      )}
    </div>
  );
}

export function SpecialHoursList({
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
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t("special.none")}</p>}
      {rows.map((r, i) => {
        const which = r.date || t("special.thisDate");
        return (
          <div key={i} className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              {t("special.date")}
              <input type="date" className={inputClass} value={r.date} onChange={(e) => set(i, { date: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={r.closed} onChange={(e) => set(i, { closed: e.target.checked })} />
              {t("closed")}
            </label>
            {!r.closed && (
              <>
                <input aria-label={t("special.opensOn", { date: which })} className={time} value={r.open} onChange={(e) => set(i, { open: e.target.value })} />
                <span aria-hidden>{t("hours.to")}</span>
                <input aria-label={t("special.closesOn", { date: which })} className={time} value={r.close} onChange={(e) => set(i, { close: e.target.value })} />
              </>
            )}
            <button
              type="button"
              className={small}
              aria-label={t("removeItem", { name: which })}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              {t("remove")}
            </button>
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className={small}
          onClick={() => onChange([...rows, { date: "", closed: true, open: "09:00", close: "13:00" }])}
        >
          {t("special.add")}
        </button>
      </div>
      <p className={hintClass}>{t("special.hint")}</p>
    </div>
  );
}

/** addPlace's errors are English sentences from the lib: keep the code, translate the sentence. */
function placeError(
  error: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  phrase: (text: string) => string,
): string {
  const m = /^([A-Z_]+): (.*)$/.exec(error);
  if (!m) return error;
  const atMost = /^At most (\d+) places\.$/.exec(m[2]!);
  return `${m[1]}: ${atMost ? t("area.atMost", { max: Number(atMost[1]) }) : phrase(m[2]!)}`;
}

export function ServiceAreaEditor({
  area,
  max,
  onChange,
}: {
  area: Area;
  max: number;
  onChange: (area: Area) => void;
}) {
  const [name, setName] = useState("");
  const [placeId, setPlaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("profile");
  const phrase = usePhrase();
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">{t("area.type")}</legend>
        {AREA_TYPES.map((t_) => (
          <label key={t_.value || "none"} className="flex items-center gap-2 text-sm">
            <input type="radio" name="area-type" checked={area.type === t_.value} onChange={() => onChange({ ...area, type: t_.value })} />
            {t(`area.types.${t_.value || "none"}`)}
          </label>
        ))}
      </fieldset>
      {area.type && (
        <>
          <ul aria-label={t("area.placesServed")} className="flex flex-wrap gap-2">
            {area.places.map((p) => (
              <li key={p.placeId} className={chip}>
                {p.placeName}
                <button
                  type="button"
                  aria-label={t("removeItem", { name: p.placeName })}
                  className={chipX}
                  onClick={() => onChange({ ...area, places: area.places.filter((x) => x.placeId !== p.placeId) })}
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label={t("area.search")} placeholder={t("area.search")} className={`${inputClass} min-w-64 flex-1`} disabled />
            <NotLiveBadge />
          </div>
          <p className={hintClass}>{t("area.searchNote")}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className={fieldLabelClass}>
              {t("area.placeName")}
              <input className={inputClass} placeholder="Rivermoor, TX" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={fieldLabelClass}>
              {t("area.placeId")}
              <input className={inputClass} value={placeId} onChange={(e) => setPlaceId(e.target.value)} />
            </label>
            <button
              type="button"
              className={small}
              onClick={() => {
                const r = addPlace(area, name, placeId, max);
                if ("error" in r) return setError(placeError(r.error, t, phrase));
                onChange(r.area);
                setName("");
                setPlaceId("");
                setError(null);
              }}
            >
              {t("area.add")}
            </button>
          </div>
          <ErrorText message={error} />
        </>
      )}
    </div>
  );
}

export function ContactFields({
  form,
  maxPhones,
  onChange,
}: {
  form: ProfileForm;
  maxPhones: number;
  onChange: (patch: Partial<ProfileForm>) => void;
}) {
  const t = useTranslations("profile");
  const phones = Array.from({ length: maxPhones }, (_, i) => form.morePhones[i] ?? "");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={fieldLabelClass}>
        {t("contact.website")}
        <input type="url" className={inputClass} placeholder="https://" value={form.website} onChange={(e) => onChange({ website: e.target.value })} />
      </label>
      <label className={fieldLabelClass}>
        {t("contact.primaryPhone")}
        <input type="tel" className={inputClass} placeholder="+1 956 555 0142" value={form.phone} onChange={(e) => onChange({ phone: e.target.value })} />
      </label>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">{t("contact.additionalPhones", { max: maxPhones })}</legend>
        {phones.map((p, i) => (
          <input
            key={i}
            type="tel"
            aria-label={t("contact.additionalPhone", { n: i + 1 })}
            className={inputClass}
            value={p}
            onChange={(e) => onChange({ morePhones: phones.map((x, j) => (j === i ? e.target.value : x)) })}
          />
        ))}
      </fieldset>
      <label className={fieldLabelClass}>
        {t("contact.openingDate")}
        <input className={inputClass} placeholder="YYYY-MM-DD" aria-describedby="open-date-hint" value={form.opening} onChange={(e) => onChange({ opening: e.target.value })} />
        <span id="open-date-hint" className={`${hintClass} font-normal`}>
          YYYY-MM-DD
        </span>
      </label>
    </div>
  );
}
