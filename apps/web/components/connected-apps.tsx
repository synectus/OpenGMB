"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ConnectedAppView } from "@opengmb/core";
import { connectedApps_disconnect, connectedApps_update } from "../app/_generated/actions";
import { TableWrap, tdClass, thClass } from "./page-parts";
import { ErrorText, buttonClass, inputClass, secondaryButtonClass } from "./ui";

const rowButtonClass =
  "inline-flex h-8 items-center rounded-control border border-input bg-card px-3 text-[13px] font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
const dangerButtonClass =
  "inline-flex h-8 items-center rounded-control border border-bad-border bg-card px-3 text-[13px] font-semibold text-bad hover:bg-bad-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

export function ConnectedApps({
  apps,
  currentUserId,
  readOnlyOnly,
  lastUsed,
}: {
  apps: ConnectedAppView[];
  currentUserId: string;
  readOnlyOnly: boolean;
  /** Last-use text per app id, formatted on the server with the person's time format (no hydration mismatch). */
  lastUsed: Record<string, string>;
}) {
  const t = useTranslations("settingsTeam.connectedApps");
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftAccess, setDraftAccess] = useState<"read" | "write">("read");
  const showOwner = apps.some((a) => a.ownerUserId !== currentUserId);

  function startEdit(a: ConnectedAppView) {
    setError(null);
    setDraftAccess(a.access);
    setEditing(a.id);
  }

  async function save(e: FormEvent<HTMLFormElement>, a: ConnectedAppView) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setPending(a.id);
    setError(null);
    const result = await connectedApps_update({
      id: a.id,
      access: draftAccess,
      fullAutonomy: draftAccess === "write" && data.get("autonomy") === "on",
    });
    setPending(null);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setEditing(null);
    router.refresh();
  }

  async function disconnect(a: ConnectedAppView) {
    if (!window.confirm(t("confirmDisconnect"))) return;
    setPending(a.id);
    setError(null);
    const result = await connectedApps_disconnect({ id: a.id });
    setPending(null);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <TableWrap>
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">{t("caption")}</caption>
          <thead className="border-b border-border bg-muted">
            <tr>
              <th scope="col" className={thClass}>{t("app")}</th>
              <th scope="col" className={thClass}>{t("site")}</th>
              {showOwner && <th scope="col" className={thClass}>{t("owner")}</th>}
              <th scope="col" className={thClass}>{t("access")}</th>
              <th scope="col" className={thClass}>{t("autonomy")}</th>
              <th scope="col" className={thClass}>{t("lastUsed")}</th>
              <th scope="col" className={thClass}>
                <span className="sr-only">{t("actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {apps.map((a) => {
              const mine = a.ownerUserId === currentUserId;
              const isEditing = editing === a.id;
              return (
                <tr key={a.id} className="text-foreground">
                  <td className={`${tdClass} font-bold`}>{a.name}</td>
                  <td className={`${tdClass} break-all`}>{a.redirectHost ?? ""}</td>
                  {showOwner && <td className={`${tdClass} break-all`}>{a.ownerEmail}</td>}
                  {isEditing ? (
                    <td className={tdClass} colSpan={2}>
                      <form
                        id={`edit-${a.id}`}
                        onSubmit={(e) => save(e, a)}
                        className="flex flex-wrap items-center gap-3"
                      >
                        <select
                          aria-label={t("accessLabel", { app: a.name })}
                          value={draftAccess}
                          onChange={(e) => setDraftAccess(e.target.value === "write" ? "write" : "read")}
                          className={inputClass}
                        >
                          <option value="read">{t("readOnly")}</option>
                          {!readOnlyOnly && <option value="write">{t("readWrite")}</option>}
                        </select>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="autonomy"
                            defaultChecked={a.fullAutonomy}
                            disabled={draftAccess !== "write"}
                            aria-label={t("autonomyLabel", { app: a.name })}
                          />
                          {t("autonomy")}
                        </label>
                      </form>
                    </td>
                  ) : (
                    <>
                      <td className={tdClass}>{a.access === "write" ? t("readWrite") : t("readOnly")}</td>
                      <td className={tdClass}>{a.fullAutonomy ? t("yes") : t("no")}</td>
                    </>
                  )}
                  <td className={`${tdClass} tabular-nums`}>{lastUsed[a.id] ?? t("never")}</td>
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-2">
                      {isEditing ? (
                        <>
                          <button type="submit" form={`edit-${a.id}`} className={buttonClass} disabled={pending === a.id}>
                            {t("save")}
                          </button>
                          <button type="button" className={secondaryButtonClass} onClick={() => setEditing(null)}>
                            {t("cancel")}
                          </button>
                        </>
                      ) : (
                        <>
                          {mine && (
                            <button type="button" className={rowButtonClass} onClick={() => startEdit(a)}>
                              {t("edit")}
                            </button>
                          )}
                          <button type="button" className={dangerButtonClass} disabled={pending === a.id} onClick={() => disconnect(a)}>
                            {t("disconnect")}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      <ErrorText message={error} />
      {readOnlyOnly && <p className="text-sm text-muted-foreground">{t("readOnlyRole")}</p>}
    </div>
  );
}
