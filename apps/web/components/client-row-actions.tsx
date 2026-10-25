"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { workspaces_delete, workspaces_rename } from "../app/_generated/actions";
import { destructiveButtonClass, ErrorText, inputClass, secondaryButtonClass } from "./ui";

/** Rename and delete for one row of the Clients table. The server decides whether a delete is allowed. */
export function ClientRowActions({ workspaceId, name }: { workspaceId: string; name: string }) {
  const t = useTranslations("workspaces.rowActions");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const r = await workspaces_rename({ workspaceId, name: String(new FormData(e.currentTarget).get("name")) });
    setPending(false);
    if (!r.ok) return setError(r.error.message);
    setEditing(false);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(t("confirmDelete", { name }))) return;
    setPending(true);
    setError(null);
    const r = await workspaces_delete({ workspaceId });
    setPending(false);
    if (!r.ok) return setError(r.error.message);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <form onSubmit={rename} aria-label={t("renameName", { name })} className="flex flex-wrap items-center gap-2">
          <input
            name="name"
            defaultValue={name}
            aria-label={t("newNameFor", { name })}
            maxLength={100}
            required
            className={`${inputClass} min-w-0 w-48`}
          />
          <button type="submit" className={secondaryButtonClass} disabled={pending}>
            {t("save")}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => { setEditing(false); setError(null); }}>
            {t("cancel")}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)} aria-label={t("renameName", { name })}>
            {t("rename")}
          </button>
          <button type="button" className={destructiveButtonClass} onClick={remove} disabled={pending} aria-label={t("deleteName", { name })}>
            {t("delete")}
          </button>
        </div>
      )}
      <ErrorText message={error} />
    </div>
  );
}
