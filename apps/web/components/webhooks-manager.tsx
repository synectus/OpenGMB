"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { webhooks_sendTest, webhooks_subscribe, webhooks_unsubscribe } from "../app/_generated/actions";
import { ErrorText, buttonClass, inputClass, secondaryButtonClass } from "./ui";

export function CreateWebhookForm({ clients }: { clients: { id: string; name: string }[] }) {
  const t = useTranslations("settingsWebhooks");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    setSecret(null);
    setCopied(false);
    const workspaceId = String(data.get("client") ?? "");
    const note = String(data.get("note") ?? "").trim();
    const result = await webhooks_subscribe({
      url: String(data.get("url")),
      ...(workspaceId ? { workspaceId } : {}),
      ...(note ? { description: note } : {}),
    });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setSecret((result.data as { secret: string }).secret);
    form.reset();
    router.refresh();
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={onSubmit} aria-label={t("form.formLabel")} className="flex flex-wrap items-end gap-2.5">
        <div className="flex max-w-[420px] flex-[1_1_280px] flex-col gap-1">
          <label htmlFor="webhook-url" className="text-xs font-semibold text-foreground">
            {t("form.urlLabel")}
          </label>
          <input
            id="webhook-url"
            name="url"
            type="url"
            required
            maxLength={2000}
            placeholder="https://"
            aria-describedby="webhook-url-hint"
            className={inputClass}
          />
          <span id="webhook-url-hint" className="text-xs text-muted-foreground">
            {t("form.urlHint")}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="webhook-client" className="text-xs font-semibold text-foreground">
            {t("form.clientLabel")}
          </label>
          <select id="webhook-client" name="client" defaultValue="" className={inputClass}>
            <option value="">{t("form.allClients")}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex max-w-[260px] flex-[1_1_180px] flex-col gap-1">
          <label htmlFor="webhook-note" className="text-xs font-semibold text-foreground">
            {t("form.noteLabel")}
          </label>
          <input id="webhook-note" name="note" maxLength={200} className={inputClass} />
        </div>
        <button type="submit" className={buttonClass} disabled={pending}>
          {t("form.add")}
        </button>
      </form>
      <ErrorText message={error} />
      {secret && (
        <section
          aria-label={t("created.label")}
          className="flex flex-col gap-2.5 rounded-xl border border-good-border bg-good-bg p-4"
        >
          <strong className="text-sm text-foreground">{t("created.copyNow")}</strong>
          <code
            data-testid="new-webhook-secret"
            className="break-all rounded-control border border-border bg-card px-3 py-2 font-mono text-sm"
          >
            {secret}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => copy(secret)}>
              {t("created.copy")}
            </button>
            {copied && <span className="text-sm text-muted-foreground">{t("created.copied")}</span>}
          </div>
        </section>
      )}
    </div>
  );
}

const rowButton =
  "inline-flex h-8 items-center rounded-control border border-input bg-card px-3 text-[13px] font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

export function WebhookRowActions({ id, active }: { id: string; active: boolean }) {
  const t = useTranslations("settingsWebhooks.list");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);

  async function sendTest() {
    setPending(true);
    setError(null);
    const result = await webhooks_sendTest({ id });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setQueued(true);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(t("confirmDelete"))) return;
    setPending(true);
    setError(null);
    const result = await webhooks_unsubscribe({ id });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {active && (
          <button type="button" onClick={sendTest} disabled={pending} className={rowButton}>
            {queued ? t("testQueued") : t("sendTest")}
          </button>
        )}
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="inline-flex h-8 items-center rounded-control border border-bad-border bg-card px-3 text-[13px] font-semibold text-bad hover:bg-bad-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
        >
          {t("delete")}
        </button>
      </div>
      <ErrorText message={error} />
    </div>
  );
}
