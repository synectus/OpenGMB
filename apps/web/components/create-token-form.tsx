"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiTokens_create } from "../app/_generated/actions";
import { mcpCommand } from "../lib/mcp-connect";
import { ErrorText, buttonClass, inputClass, secondaryButtonClass } from "./ui";

export function CreateTokenForm({
  readOnlyOnly = false,
  mcpUrl,
}: {
  readOnlyOnly?: boolean;
  mcpUrl: string | null;
}) {
  const t = useTranslations("settingsTeam.createToken");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    setCreated(null);
    setCopied(null);
    const data = new FormData(form);
    const result = await apiTokens_create({
      name: String(data.get("name")),
      scopes: data.get("access") === "read" || readOnlyOnly ? ["read"] : ["read", "write"],
      mode: data.get("mode") === "full_autonomy" ? "full_autonomy" : "human_in_the_loop",
    });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setCreated((result.data as { token: string }).token);
    form.reset();
    router.refresh();
  }

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
  }

  const command = created && mcpUrl ? mcpCommand(mcpUrl, created) : "";

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={onSubmit} aria-label={t("formLabel")} className="flex flex-wrap items-end gap-2.5">
        <div className="flex max-w-[360px] flex-[1_1_240px] flex-col gap-1">
          <label htmlFor="name" className="text-xs font-semibold text-foreground">
            {t("nameLabel")}
          </label>
          <input id="name" name="name" maxLength={100} required className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="access" className="text-xs font-semibold text-foreground">
            {t("accessLabel")}
          </label>
          <select
            id="access"
            name="access"
            defaultValue={readOnlyOnly ? "read" : "write"}
            disabled={readOnlyOnly}
            className={inputClass}
          >
            <option value="read">{t("readOnly")}</option>
            {!readOnlyOnly && <option value="write">{t("readWrite")}</option>}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="mode" className="text-xs font-semibold text-foreground">
            {t("modeLabel")}
          </label>
          <select id="mode" name="mode" defaultValue="human_in_the_loop" className={inputClass}>
            <option value="human_in_the_loop">{t("modeHumanInTheLoop")}</option>
            <option value="full_autonomy">{t("modeFullAutonomy")}</option>
          </select>
        </div>
        <button type="submit" className={buttonClass} disabled={pending}>
          {t("create")}
        </button>
      </form>
      <p className="text-sm text-muted-foreground">{t("modeHint")}</p>
      {readOnlyOnly && (
        <p className="text-sm text-muted-foreground">{t("readOnlyRole")}</p>
      )}
      <ErrorText message={error} />
      {created && (
        <section
          aria-label={t("createdLabel")}
          className="flex flex-col gap-2.5 rounded-xl border border-good-border bg-good-bg p-4"
        >
          <strong className="text-sm text-foreground">
            {t("copyNow")}
          </strong>
          <code
            data-testid="new-token"
            className="break-all rounded-control border border-border bg-card px-3 py-2 font-mono text-sm"
          >
            {created}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => copy("token", created)}>
              {t("copyToken")}
            </button>
            {command && (
              <button type="button" className={secondaryButtonClass} onClick={() => copy("command", command)}>
                {t("copyCommand")}
              </button>
            )}
            {copied && <span className="text-sm text-muted-foreground">{t("copiedWhat", { what: t(copied === "token" ? "whatToken" : "whatCommand") })}</span>}
          </div>
          {command && (
            <>
              <span className="text-sm text-foreground">{t("addToClaude")}</span>
              <pre className="m-0 whitespace-pre-wrap break-all rounded-control border border-border bg-card px-3 py-2 font-mono text-[13px]">
                {command}
              </pre>
            </>
          )}
        </section>
      )}
    </div>
  );
}
