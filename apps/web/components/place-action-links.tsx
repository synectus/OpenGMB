"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { placeActionsList } from "@opengmb/core";
import {
  placeActions_create,
  placeActions_delete,
  placeActions_list,
  placeActions_update,
} from "../app/_generated/actions";
import { runCall } from "./post-card";
import { linkFailure, linkOpText, placeActionLabel } from "../lib/profile-editor";
import { h2Class, sectionClass } from "./profile/section";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "./ui";

type Listed = Awaited<ReturnType<(typeof placeActionsList)["handler"]>>;
export type PlaceLink = Listed["links"][number];
export type PlaceOp = Listed["operations"][number];

const POLL_MS = 1500;
const POLL_TRIES = 40;

async function settle(locationId: string, opId: string, stillWorking: string): Promise<string | null> {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    const r = await runCall<Listed>(() => placeActions_list({ locationId }));
    if ("error" in r) return r.error;
    const op = r.data.operations.find((o) => o.id === opId);
    if (op && op.status === "failed") return linkFailure(op.error);
    if (op && op.status !== "pending") return null;
  }
  return stillWorking;
}

/** Place action links (booking / ordering buttons). Writes are queued; Google is updated by the worker. */
export function PlaceActionLinks({
  locationId,
  canEdit,
  types,
  links,
  operations,
  loadError,
  googleDenied = false,
}: {
  locationId: string;
  canEdit: boolean;
  types: readonly string[];
  links: PlaceLink[];
  operations: PlaceOp[];
  loadError: string | null;
  /** Google refuses to share this location's place action links with the connected account. */
  googleDenied?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("locationHub.place");
  const [type, setType] = useState(types[0] ?? "APPOINTMENT");
  const [uri, setUri] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function queue(fn: () => Promise<{ ok: boolean }>) {
    setBusy(true);
    setError(null);
    const r = await runCall<{ operation: PlaceOp }>(fn as never);
    if ("error" in r) {
      setBusy(false);
      return setError(r.error);
    }
    const problem = await settle(locationId, r.data.operation.id, t("stillWorking"));
    setBusy(false);
    if (problem) setError(problem);
    router.refresh();
  }

  const pending = operations.filter((o) => o.status === "pending");
  return (
    <section aria-labelledby="place-actions" className={sectionClass}>
      <h2 id="place-actions" className={h2Class}>{t("title")}</h2>
      <ErrorText message={loadError} />
      {googleDenied && (
        <p role="note" className="rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">{t("googleDenied")}</p>
      )}
      <ul className="flex flex-col gap-2">
        {links.map((l) => (
          <li key={l.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <span className="min-w-0 flex-[1_1_200px] break-all">
              {placeActionLabel(l.placeActionType)} · {l.uri}
              {l.isPreferred ? ` ${t("preferred")}` : ""}
              {!l.isEditable ? ` ${t("managedElsewhere")}` : ""}
            </span>
            {canEdit && l.isEditable && (
              <span className="flex gap-1">
                {!l.isPreferred && (
                  <button type="button" className={secondaryButtonClass} disabled={busy}
                    onClick={() => queue(() => placeActions_update({ locationId, name: l.name, isPreferred: true }))}>
                    {t("makePreferred")}
                  </button>
                )}
                <button type="button" className={secondaryButtonClass} disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("removeConfirm")))
                      void queue(() => placeActions_delete({ locationId, name: l.name }));
                  }}>
                  {t("remove")}
                </button>
              </span>
            )}
          </li>
        ))}
        {links.length === 0 && !loadError && <li className="text-sm text-muted-foreground">{t("none")}</li>}
      </ul>
      {pending.map((o) => (
        <p key={o.id} role="status" className="rounded-lg bg-info-bg px-3 py-2 text-sm font-semibold text-info">
          {linkOpText(o.kind)}
        </p>
      ))}
      <ErrorText message={error} />
      {canEdit && (
        <form
          aria-label={t("addAria")}
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await queue(() => placeActions_create({ locationId, placeActionType: type, uri, isPreferred: preferred }));
            setUri("");
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("linkType")}
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
              {types.map((t) => (
                <option key={t} value={t}>{placeActionLabel(t)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("linkUrl")}
            <input type="url" required placeholder="https://example.com/book" value={uri}
              onChange={(e) => setUri(e.target.value)} className={inputClass} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={preferred} onChange={(e) => setPreferred(e.target.checked)} />
            {t("preferredLabel")}
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={buttonClass} disabled={busy}>
              {busy ? t("working") : t("add")}
            </button>
            <span className="text-xs text-muted-foreground">{t("removeNote")}</span>
          </div>
        </form>
      )}
    </section>
  );
}
