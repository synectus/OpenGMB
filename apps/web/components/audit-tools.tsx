"use client";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import type { auditExport, auditVerify } from "@opengmb/core";
import { startOfZonedDay } from "@opengmb/core/time";
import { audit_export, audit_verify } from "../app/_generated/actions";
import { useTimeFormat } from "./time-format-provider";
import { ErrorText, Field, Panel, buttonClass, inputClass, secondaryButtonClass } from "./ui";

type Verified = Awaited<ReturnType<typeof auditVerify.handler>>;
type Exported = Awaited<ReturnType<typeof auditExport.handler>>;

/** `YYYY-MM-DD` from a date input is read as the start of that day in the client's zone. */
const dayStart = (d: string, timeZone: string) => (d ? startOfZonedDay(d, timeZone).toISOString() : undefined);

/**
 * The verify result is the page's ONLY role="status" element (the e2e smoke test reads it with a
 * strict getByRole("status")). It is always rendered, empty until the first check. The export
 * note uses aria-live without a role for the same reason.
 */
export function AuditTools({ orgId }: { orgId: string }) {
  const t = useTranslations("audit.tools");
  const tf = useTimeFormat();
  const [verified, setVerified] = useState<Verified | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [afterId, setAfterId] = useState<number | undefined>();

  async function onVerify() {
    setVerifying(true);
    setError(null);
    setVerified(null);
    const result = await audit_verify();
    setVerifying(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setVerified(result.data as Verified);
  }

  async function onExport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const format = String(f.get("format")) as "csv" | "json";
    const from = String(f.get("from"));
    const to = String(f.get("to"));
    setExporting(true);
    setError(null);
    setNote(null);
    const result = await audit_export({ format, from: dayStart(from, tf.zone()), to: dayStart(to, tf.zone()), afterId });
    setExporting(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    const data = result.data as Exported;
    const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
    const url = URL.createObjectURL(new Blob([data.content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `opengmb-audit-${orgId}-${from || "start"}-${to || "end"}${afterId === undefined ? "" : `-after${afterId}`}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    setAfterId(data.truncated ? data.nextAfterId : undefined);
    setNote(
      data.truncated
        ? t("downloadedMore", { count: data.rowCount.toLocaleString("en-US") })
        : t("downloaded", { count: data.rowCount.toLocaleString("en-US") }),
    );
  }

  return (
    <>
      <div className="grid items-start gap-4 md:grid-cols-2">
        <Panel title={t("checkTitle")}>
          <div>
            <button type="button" onClick={onVerify} disabled={verifying} className={buttonClass}>
              {t("verify")}
            </button>
          </div>
          <div role="status" className="text-sm">
            {verifying && <span className="text-muted-foreground">{t("checking")}</span>}
            {verified && (
              <>
                <p className={`font-semibold ${verified.ok ? "text-good" : "text-bad"}`}>
                  {t(verified.ok ? "intact" : "broken", {
                    checked: verified.checked.toLocaleString("en-US"),
                    checkpoint: String(verified.checkpoint),
                  })}
                </p>
                {verified.breaks.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {verified.breaks.map((b, i) => (
                      <li key={i}>
                        <code className="font-mono">
                          {b.kind}
                          {b.id === undefined ? "" : ` ${t("breakRow", { id: String(b.id) })}`}
                        </code>
                        : {b.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </Panel>
        <Panel title={t("exportTitle")}>
          <form onSubmit={onExport} aria-label={t("exportAria")} className="flex flex-wrap items-end gap-2.5">
            <div className="flex flex-col gap-1">
              <label htmlFor="format" className="text-xs font-semibold text-foreground">
                {t("format")}
              </label>
              <select id="format" name="format" className={inputClass} onChange={() => setAfterId(undefined)}>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <Field label={t("from")} id="from" type="date" onChange={() => setAfterId(undefined)} />
            <Field label={t("to")} id="to" type="date" onChange={() => setAfterId(undefined)} />
            <button
              type="submit"
              disabled={exporting}
              className={afterId === undefined ? secondaryButtonClass : buttonClass}
            >
              {afterId === undefined ? t("export") : t("exportNext")}
            </button>
          </form>
          <p className="text-xs text-muted-foreground">{t("exportNote")}</p>
          {note && (
            <p aria-live="polite" className="text-sm">
              {note}
            </p>
          )}
        </Panel>
      </div>
      <ErrorText message={error} />
    </>
  );
}
