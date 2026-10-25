"use client";
import Link from "next/link";
import { statusWords } from "@/lib/labels";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { profile_preview, profile_propose } from "../../app/_generated/actions";
import { approvalsHref, itemKey } from "../../lib/approvals";
import { canPropose, previewRow, type BulkGroup, type BulkLoc } from "../../lib/bulk-edit";
import { SERVICE_CAP, sendLists, type CopyItem } from "../../lib/copy-services";
import { LocationPicker } from "../location-picker";
import { Pill } from "../page-parts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../primitives/dialog";
import { runCall } from "../post-card";
import type { PreviewLoc } from "../profile-forms";
import { buttonClass, ErrorText, secondaryButtonClass } from "../ui";
import { hintClass } from "./section";

export type CopyTargets = { workspaceId: string; locations: BulkLoc[]; groups: BulkGroup[] };

/**
 * Copies services to other locations of the workspace. Reuses Bulk edit's add path: preview (with
 * per-location flags) then one change set for every target, which waits for approval.
 */
export function CopyServicesDialog({
  title,
  items,
  targets,
  onClose,
}: {
  title: string;
  items: CopyItem[];
  targets: CopyTargets;
  onClose: () => void;
}) {
  const t = useTranslations("profile");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewLoc[] | null>(null);
  const [proposed, setProposed] = useState<{ id: string; status: string } | null>(null);
  const add = items.map((i) => i.item);
  const names = items.map((i) => i.name);

  const pick = (ids: string[]) => {
    setPicked(ids);
    setPreview(null);
    setProposed(null);
  };

  async function doPreview() {
    setBusy(true);
    setError(null);
    setPreview(null);
    const r = await runCall<{ locations: PreviewLoc[] }>(() =>
      profile_preview({ locationIds: picked, fields: {}, addServiceItems: add, skipUnofferedServices: true }),
    );
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setPreview(r.data.locations);
  }

  async function doPropose() {
    if (!preview) return;
    const readable = preview.filter((l) => !l.error);
    setBusy(true);
    setError(null);
    const r = await runCall<{ changeSet: { id: string; status: string } }>(() =>
      profile_propose({
        workspaceId: targets.workspaceId,
        locationIds: readable.map((l) => l.locationId),
        fields: {},
        addServiceItems: add,
        skipUnofferedServices: true,
        serviceAddSend: sendLists(readable),
        snapshots: readable.map((l) => ({ locationId: l.locationId, current: l.current })),
      }),
    );
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setProposed(r.data.changeSet);
  }

  // The lib's copyNotes builds English sentences; the same facts are read from the preview and phrased here.
  const rows = (preview ?? []).map((l) => {
    const add = l.serviceAdd;
    const reason = (code: string) =>
      t.has(`copy.reasons.${code}`) ? t(`copy.reasons.${code}`, { cap: SERVICE_CAP }) : code;
    return {
      l,
      row: previewRow(l),
      added: add ? add.send.length : 0,
      unchanged: add && add.alreadyThere.length > 0 ? add.alreadyThere.length : 0,
      flags: add
        ? add.skipped.map((x) =>
            t("copy.flag", { name: names[x.index] ?? t("copy.service"), reason: reason(x.reason) }),
          )
        : [],
    };
  });
  const addedTotal = rows.reduce((n, r) => n + r.added, 0);
  const skippedTotal = rows.reduce((n, r) => n + r.flags.length, 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("copy.description", { count: items.length })}
          </DialogDescription>
        </DialogHeader>
        <LocationPicker locations={targets.locations} groups={targets.groups} picked={picked} onPick={pick} />
        {targets.locations.length === 0 && <p className={hintClass}>{t("copy.noOthers")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={secondaryButtonClass} disabled={busy || picked.length === 0} onClick={doPreview}>
            {t("copy.preview")}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !canPropose(preview) || proposed !== null}
            onClick={doPropose}
          >
            {t("copy.propose")}
          </button>
        </div>
        <ErrorText message={error} />
        {preview && (
          <section aria-label={t("copy.previewLabel")} className="flex flex-col gap-2">
            <p role="status" className={hintClass}>{t("copy.summary", { added: addedTotal, skipped: skippedTotal })}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {rows.map(({ l, row, added, unchanged, flags }) => (
                <li key={l.locationId} className="flex flex-col gap-1 rounded-control border border-border px-3 py-2 text-[13px]">
                  <div className="flex items-center gap-2">
                    <strong className="min-w-0 flex-1">{row.name}</strong>
                    <Pill tone={row.tone}>{row.result}</Pill>
                  </div>
                  {row.error && <span className="text-bad">{row.error}</span>}
                  {added > 0 && <span>{t("copy.willBeAdded", { count: added })}</span>}
                  {unchanged > 0 && <span className="text-muted-foreground">{t("copy.unchanged", { count: unchanged })}</span>}
                  {flags.length > 0 && (
                    <ul role="list" aria-label={t("copy.notSentTo", { name: row.name })} className="m-0 list-disc pl-5 text-warn">
                      {flags.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {proposed && (
          <p aria-live="polite" className="rounded-control border border-good-border bg-good-bg px-3 py-2 text-[13px] text-good">
            {t("copy.recorded", { status: statusWords(proposed.status) })}{" "}
            <Link href={approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: proposed.id }) })} className="font-bold text-brand-text underline underline-offset-2">
              {t("copy.review")}
            </Link>
          </p>
        )}
        <DialogFooter>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>{t("close")}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
