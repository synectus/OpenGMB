"use client";
import { useId } from "react";
import { useTranslations } from "next-intl";
import { sendTimeInstant, sendTimeProblem } from "../lib/posts";
import { useTimeFormat } from "./time-format-provider";
import { ErrorText, inputClass, secondaryButtonClass } from "./ui";

const DEFAULT_TIME = "09:00";

/**
 * Date and time of a send, read in the client's zone (never the browser's). `value` is a
 * datetime-local string ("2026-10-19T09:00"), "" for nothing picked; a half-picked value ("2026-10-19T")
 * is kept so the other input can be filled next. Shows the zone, what the pick means as an instant,
 * and a message for a time that has passed (the buttons that save are onClick handlers, so the
 * browser's own `min` check never runs: callers also check with `sendTimeProblem`).
 */
export function SchedulePicker({
  label,
  value,
  onChange,
  workspaceId,
  disabled = false,
  clearable = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  workspaceId: string;
  disabled?: boolean;
  clearable?: boolean;
}) {
  const id = useId();
  const t = useTranslations("posts");
  const tf = useTimeFormat();
  const zone = tf.zone(workspaceId);
  const [date = "", time = ""] = value.split("T");
  const problem = sendTimeProblem(t, value, zone);
  const instant = problem ? null : sendTimeInstant(value, zone);
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 text-[13px] font-semibold text-foreground">{label}</legend>
      <div className="flex flex-wrap items-end gap-2.5">
        <label htmlFor={`${id}-date`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("pick.date")}
          <input
            id={`${id}-date`}
            type="date"
            className={inputClass}
            value={date}
            min={tf.today(workspaceId)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value ? `${e.target.value}T${time || DEFAULT_TIME}` : "")}
          />
        </label>
        <label htmlFor={`${id}-time`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("pick.time")}
          <input
            id={`${id}-time`}
            type="time"
            className={inputClass}
            value={time}
            disabled={disabled}
            onChange={(e) => onChange(`${date}T${e.target.value}`)}
          />
        </label>
        {clearable && value !== "" && (
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={disabled}
            onClick={() => onChange("")}
          >
            {t("common.clear")}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("pick.zoneNote", { zone, label: tf.label(workspaceId, instant ?? undefined) })}
      </p>
      {instant && (
        <p role="status" className="text-xs font-medium text-foreground">
          {tf.dateTime(instant, workspaceId)} {tf.label(workspaceId, instant)}
        </p>
      )}
      <ErrorText message={problem} />
    </fieldset>
  );
}
