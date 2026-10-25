"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { posts_bulkCreateDrafts, posts_bulkPreview } from "../../app/_generated/actions";
import { postsHref } from "../../lib/posts";
import { runCall } from "../post-card";
import { useTimeFormat } from "../time-format-provider";
import { Badge, buttonClass, ErrorText, inputClass, Panel, secondaryButtonClass } from "../ui";

type Row = {
  line: number;
  location: string | null;
  topicType: string | null;
  summary: string;
  scheduledFor: string | null;
  errors: string[];
  warnings: string[];
};
type Preview = { fileErrors: string[]; rows: Row[]; total: number; valid: number; withErrors: number };
type Column = { name: string; required: boolean; help: string };

export function BulkImport({
  workspaceId,
  workspaceName,
  maxRows,
  variables,
  columns,
  template,
}: {
  workspaceId: string;
  workspaceName: string;
  maxRows: number;
  variables: string[];
  columns: Column[];
  template: string;
}) {
  const t = useTranslations("posts");
  const tf = useTimeFormat();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (text: string) => {
    setCsv(text);
    setPreview(null); // a preview only ever describes the text it was made from
    setDone(null);
    setError(null);
  };
  async function pick(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    edit(await file.text());
  }
  async function check() {
    setBusy(true);
    setDone(null);
    const r = await runCall<Preview>(() => posts_bulkPreview({ workspaceId, csv }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setError(null);
    setPreview(r.data);
  }
  async function create() {
    setBusy(true);
    const r = await runCall<{ created: number }>(() => posts_bulkCreateDrafts({ workspaceId, csv }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setError(null);
    setPreview(null);
    setCsv("");
    setFileName(null);
    setDone(r.data.created);
  }

  const canCreate = !!preview && preview.fileErrors.length === 0 && preview.total > 0 && preview.withErrors === 0;

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title={t("bulk.title", { name: workspaceName })}
        description={t("bulk.description", { max: maxRows })}
      >
        <div className="flex flex-wrap items-center gap-2">
          <a
            className={secondaryButtonClass}
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}
            download="synectus-posts-template.csv"
          >
            {t("bulk.downloadTemplate")}
          </a>
          <label className={`${secondaryButtonClass} cursor-pointer`}>
            {t("bulk.chooseCsv")}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label={t("bulk.csvFile")}
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </label>
          {fileName && <span className="break-all text-sm text-muted-foreground">{fileName}</span>}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("bulk.fromSheets")}
        </p>
        <label htmlFor="bulk-csv" className="text-sm font-medium text-foreground">
          {t("bulk.rows")}
        </label>
        <textarea
          id="bulk-csv"
          className={`${inputClass} h-48 w-full font-mono text-xs`}
          value={csv}
          onChange={(e) => edit(e.target.value)}
          placeholder="location,type,summary,cta_type,cta_url,scheduled"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} disabled={busy || !csv.trim()} onClick={() => void check()}>
            {busy && !preview ? t("bulk.checking") : t("bulk.preview")}
          </button>
        </div>
        <ErrorText message={error} />
        {done !== null && (
          <p role="status" className="text-sm font-medium text-good">
            {t.rich("bulk.created", {
              count: done,
              link: (chunks) => (
                <Link href={postsHref("list", workspaceId)} className="underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
      </Panel>

      {preview && (
        <Panel
          title={t("bulk.preview")}
          description={
            preview.fileErrors.length > 0
              ? undefined
              : t("bulk.previewSummary", { total: preview.total, valid: preview.valid, errors: preview.withErrors, zone: tf.label(workspaceId) })
          }
        >
          {preview.fileErrors.map((m) => (
            <ErrorText key={m} message={m} />
          ))}
          <ul className="flex flex-col gap-2" aria-label={t("bulk.rows")}>
            {preview.rows.map((r) => (
              <li key={r.line} className="flex flex-col gap-1 rounded-control border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{t("bulk.line", { line: r.line })}</span>
                  <span className="break-words">{r.location ?? t("bulk.unknownLocation")}</span>
                  {r.topicType && <Badge>{r.topicType.toLowerCase()}</Badge>}
                  {r.errors.length > 0 ? <Badge tone="danger">{t("bulk.error")}</Badge> : <Badge tone="success">{t("bulk.ready")}</Badge>}
                  {r.scheduledFor && (
                    <span className="text-muted-foreground">{t("bulk.sendTime", { time: tf.dateTime(r.scheduledFor, workspaceId) })}</span>
                  )}
                </div>
                {r.summary && <p className="whitespace-pre-wrap break-words text-foreground">{r.summary}</p>}
                {r.errors.map((m) => (
                  <p key={m} className="break-words font-medium text-bad">
                    {m}
                  </p>
                ))}
                {r.warnings.map((m) => (
                  <p key={m} className="break-words text-warn">
                    {t("bulk.needsFixing", { message: m })}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {canCreate ? (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={buttonClass} disabled={busy} onClick={() => void create()}>
                {busy ? t("bulk.creating") : t("bulk.create", { count: preview.total })}
              </button>
              <span className="text-sm text-muted-foreground">{t("bulk.nothingSent")}</span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("bulk.fixRows")}
            </p>
          )}
        </Panel>
      )}

      <Panel
        title={t("bulk.columns")}
        description={t("bulk.variables", { vars: variables.map((v) => `{${v}}`).join(" ") })}
      >
        <ul className="flex flex-col gap-2 text-sm" aria-label={t("bulk.columns")}>
          {columns.map((c) => (
            <li key={c.name} className="flex flex-col gap-0.5">
              <span className="font-semibold">
                <code className="break-all">{c.name}</code>
                {c.required ? ` ${t("bulk.required")}` : ""}
              </span>
              <span className="text-muted-foreground">{c.help}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
