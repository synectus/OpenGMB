"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DATE_FORMATS, formatDayKey, isValidTimeZone, timeZoneList, zoneLabel, type DateFormat } from "@opengmb/core/time";
import { workspaces_setTimeSettings } from "../app/_generated/actions";
import { buttonClass, ErrorText, inputClass } from "./ui";

/** The client's time zone and date format (F4). Every time in the app, and every schedule, follows them. */
export function WorkspaceTimeForm({
  workspaceId,
  workspaceName,
  timeZone,
  dateFormat,
  derived,
  canConfigure,
}: {
  workspaceId: string;
  workspaceName: string;
  timeZone: string;
  dateFormat: DateFormat;
  /** The zone came from a location address, not from a person. */
  derived: boolean;
  canConfigure: boolean;
}) {
  const t = useTranslations("settings.timeForm");
  const router = useRouter();
  const [zone, setZone] = useState(timeZone);
  const [fmt, setFmt] = useState<DateFormat>(dateFormat);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const zoneOk = isValidTimeZone(zone);
  const dirty = zone !== timeZone || fmt !== dateFormat;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!zoneOk) return setError(t("badZone"));
    setPending(true);
    setError(null);
    const r = await workspaces_setTimeSettings({
      workspaceId,
      ...(zone !== timeZone ? { timeZone: zone } : {}),
      ...(fmt !== dateFormat ? { dateFormat: fmt } : {}),
    });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-lg font-bold">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("intro", { name: workspaceName })}
        {derived && ` ${t("derived")}`}
      </p>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("timeZone")}
        <input
          className={inputClass}
          list="time-zone-list"
          value={zone}
          disabled={!canConfigure || pending}
          onChange={(e) => {
            setSaved(false);
            setZone(e.target.value);
          }}
          aria-invalid={!zoneOk}
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="time-zone-list">
          {timeZoneList().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        {zoneOk && <span className="text-xs font-normal text-muted-foreground">{t("now", { zone: zoneLabel(zone) })}</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("dateFormat")}
        <select
          className={inputClass}
          value={fmt}
          disabled={!canConfigure || pending}
          onChange={(e) => {
            setSaved(false);
            setFmt(e.target.value as DateFormat);
          }}
        >
          {DATE_FORMATS.map((f) => (
            <option key={f} value={f}>
              {t("dateOption", { format: f, example: formatDayKey("2026-10-19", f) })}
            </option>
          ))}
        </select>
      </label>
      <ErrorText message={error} />
      {canConfigure ? (
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={pending || !dirty}>
            {pending ? t("saving") : t("save")}
          </button>
          {saved && <span className="text-sm text-good" role="status">{t("saved")}</span>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ownersOnly")}</p>
      )}
    </form>
  );
}
