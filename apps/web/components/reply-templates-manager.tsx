"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  replyTemplates_create,
  replyTemplates_delete,
  replyTemplates_update,
} from "../app/_generated/actions";
import { analyseTemplate, notAllowedHere, VARIABLE_HELP } from "../lib/reply-templates";
import { buttonClass, destructiveButtonClass, ErrorText, inputClass, secondaryButtonClass } from "./ui";

const VARIABLE_KEY: Record<string, "varReviewerFirstName" | "varLocationName" | "varPhone"> = {
  "{reviewer_first_name}": "varReviewerFirstName",
  "{location_name}": "varLocationName",
  "{phone}": "varPhone",
};

export type TemplateRow = { id: string; name: string; body: string; generic: boolean };

function GenericBadge({ generic }: { generic: boolean }) {
  const t = useTranslations("settingsTeam.replyTemplates");
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-xs font-bold ${
        generic ? "bg-good-bg text-good" : "bg-warn-bg text-warn"
      }`}
    >
      {generic ? t("generic") : t("usesReviewerName")}
    </span>
  );
}

function Editor({
  initial,
  isNew,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; body: string };
  isNew: boolean;
  onSubmit: (v: { name: string; body: string }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const t = useTranslations("settingsTeam.replyTemplates");
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const a = analyseTemplate(body);
  const unknown =
    a.unknown.length === 0 ? null : t("unknownVariable", { names: a.unknown.map((u) => `{${u}}`).join(", ") });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const err = await onSubmit({ name, body });
    setPending(false);
    if (err) setError(err);
  }

  return (
    <form
      onSubmit={submit}
      aria-label={t("editTemplate")}
      className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card"
    >
      <h2 className="font-display text-lg font-bold">{isNew ? t("newTemplate") : t("editTemplate")}</h2>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        {t("name")}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className={`${inputClass} font-normal`} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        {t("replyText")}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} required className={`${inputClass} resize-y font-normal`} />
      </label>
      {unknown && (
        <p role="status" className="text-sm font-semibold text-bad">
          {unknown}
        </p>
      )}
      {body.trim() !== "" && (
        <div className="flex flex-col gap-1 rounded-control bg-muted p-3 text-sm">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t("preview")}</span>
          <p>{a.preview}</p>
        </div>
      )}
      <ErrorText message={error} />
      <div className="flex gap-3">
        <button type="submit" className={buttonClass} disabled={pending}>
          {isNew ? t("createTemplate") : t("saveTemplate")}
        </button>
        <button type="button" onClick={onCancel} className={secondaryButtonClass}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function Row({ t: tpl, canConfigure, genericOnly, onEdit }: { t: TemplateRow; canConfigure: boolean; genericOnly: boolean; onEdit: () => void }) {
  const t = useTranslations("settingsTeam.replyTemplates");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const blocked = notAllowedHere(tpl.generic, genericOnly);

  async function remove() {
    if (!window.confirm(t("confirmDelete", { name: tpl.name }))) return;
    const r = await replyTemplates_delete({ id: tpl.id });
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.refresh();
  }

  return (
    <li className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{tpl.name}</span>
        <GenericBadge generic={tpl.generic} />
      </div>
      <p className="whitespace-pre-wrap text-sm">{tpl.body}</p>
      {blocked && (
        <p className="text-sm font-semibold text-warn">{t("notAllowed")}</p>
      )}
      <div className="flex flex-col gap-1 rounded-control bg-muted p-3 text-sm">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{t("preview")}</span>
        <p>{analyseTemplate(tpl.body).preview}</p>
      </div>
      <ErrorText message={error} />
      {canConfigure && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onEdit} className={secondaryButtonClass}>
            {t("edit")}
          </button>
          <button type="button" onClick={remove} className={destructiveButtonClass}>
            {t("delete")}
          </button>
          <span className="text-xs text-muted-foreground">{t("deleteNote")}</span>
        </div>
      )}
    </li>
  );
}

export function ReplyTemplatesManager({
  workspaceId,
  templates,
  canConfigure,
  genericOnly,
}: {
  workspaceId: string;
  templates: TemplateRow[];
  canConfigure: boolean;
  genericOnly: boolean;
}) {
  const t = useTranslations("settingsTeam.replyTemplates");
  const router = useRouter();
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const current = templates.find((x) => x.id === editing);
  const anyBlocked = templates.some((x) => notAllowedHere(x.generic, genericOnly));

  const save = async (v: { name: string; body: string }) => {
    const r =
      editing === "new"
        ? await replyTemplates_create({ workspaceId, ...v })
        : await replyTemplates_update({ id: editing!, ...v });
    if (!r.ok) return `${r.error.code}: ${r.error.message}`;
    setEditing(null);
    router.refresh();
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      {!canConfigure && (
        <p role="status" className="rounded-panel border border-info-border bg-info-bg px-4 py-3 text-sm text-info">
          {t("viewOnly")}
        </p>
      )}
      <section aria-labelledby="vars-h" className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <h2 id="vars-h" className="font-display text-lg font-bold">{t("variables")}</h2>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          {VARIABLE_HELP.map((v) => (
            <div key={v.name} className="contents">
              <dt><code className="font-mono text-[13px]">{v.name}</code></dt>
              <dd className="text-muted-foreground">{t(VARIABLE_KEY[v.name] ?? "varPhone")}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[13px] text-muted-foreground">
          {t.rich("genericNote", {
            variable: "{reviewer_first_name}",
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </section>

      {anyBlocked && (
        <p role="status" className="rounded-panel border border-warn-border bg-warn-bg px-4 py-3 text-sm text-warn">
          {t("genericOnlyBanner", { variable: "{reviewer_first_name}" })}
        </p>
      )}

      <section aria-labelledby="list-h" className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="list-h" className="font-display text-lg font-bold">{t("templatesCount", { count: templates.length })}</h2>
          {canConfigure && editing === null && (
            <button type="button" onClick={() => setEditing("new")} className={buttonClass}>
              {t("createTemplate")}
            </button>
          )}
        </div>
        {templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTemplates")}</p>
        ) : (
          <ul aria-label={t("listLabel")}>
            {templates.map((x) => (
              <Row
                key={`${x.id}-${x.name}-${x.body}`}
                t={x}
                canConfigure={canConfigure}
                genericOnly={genericOnly}
                onEdit={() => setEditing(x.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {canConfigure && editing !== null && (
        <Editor
          key={editing}
          isNew={editing === "new"}
          initial={current ?? { name: "", body: "" }}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
