"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { googleNotifications_registerAll } from "../app/_generated/actions";
import { ErrorText, buttonClass } from "./ui";

type Reg = { accountName: string; registeredAt: string | null; lastError: string | null };

/** Instant review alerts: the address Pub/Sub pushes to, the "apply to all" button and each account's result. */
export function ApplyPubsub(p: { pushUrl: string; topicSet: boolean; lastPush: string | null; registrations: Reg[] }) {
  const t = useTranslations("integrations.pubsub");
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onApply() {
    setPending(true);
    setQueued(false);
    setError(null);
    const r = await googleNotifications_registerAll({});
    setPending(false);
    if (!r.ok) return setError(r.error.message);
    setQueued(true);
  }

  return (
    <div className="flex flex-col gap-3 pt-4">
      <p className="text-xs text-muted-foreground">{t("pushUrl", { url: p.pushUrl })}</p>
      <p className="text-xs text-muted-foreground">{t("setupHint")}</p>
      <div>
        <button type="button" onClick={onApply} className={buttonClass} disabled={pending || !p.topicSet}>
          {pending ? t("applying") : t("apply")}
        </button>
      </div>
      {queued && (
        <p role="status" className="text-sm font-semibold">
          {t("queued")}
        </p>
      )}
      <ErrorText message={error} />
      {p.registrations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {p.registrations.map((r) => (
            <li key={r.accountName} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between">
              <span className="break-all font-semibold">{r.accountName}</span>
              <span className={r.lastError ? "text-bad" : "text-muted-foreground"}>
                {r.lastError
                  ? t("failed", { error: r.lastError })
                  : t("registered", { when: r.registeredAt ?? "" })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{p.lastPush ? t("lastPush", { when: p.lastPush }) : t("noPush")}</p>
    </div>
  );
}
