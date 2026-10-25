"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  profile_changes_accept,
  profile_changes_dismiss,
  profile_changes_revert,
} from "../../app/_generated/actions";
import {
  alertsHref,
  changeSummary,
  foundCell,
  runSequentially,
  selectableIds,
  toggleAllSelected,
  type AlertFilters,
} from "../../lib/alerts";
import { approvalsHref, itemKey } from "../../lib/approvals";
import { foundLine, revertLine, revertLink, revertTone, type ChangeData } from "../../lib/changes";
import { useTimeFormat } from "../time-format-provider";
import { ProvenanceChip } from "../approvals/provenance-chip";
import { ChangeDiff } from "../changes/change-diff";
import { Pill } from "../page-parts";
import { secondaryButtonClass } from "../ui";

const btn = `${secondaryButtonClass} min-h-8 px-2.5 text-xs`;
const ghost =
  "inline-flex min-h-8 items-center rounded-control px-2.5 text-xs font-semibold text-secondary-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkCls = "text-[13px] font-bold text-brand-text underline underline-offset-2 hover:text-foreground";
const th = "px-3 py-2 text-xs font-semibold text-muted-foreground";

function CodeLine({ message }: { message: string }) {
  const at = message.indexOf(":");
  return (
    <p role="alert" className="text-[13px] text-bad">
      <span className="font-mono">{message.slice(0, at)}</span>
      {message.slice(at)}
    </p>
  );
}

export function AlertsInbox({
  filters,
  changes,
  pubsubLive,
}: {
  filters: AlertFilters;
  changes: ChangeData[];
  pubsubLive: boolean;
}) {
  const t = useTranslations("locations");
  const router = useRouter();
  const tf = useTimeFormat();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [proposed, setProposed] = useState<string | null>(null);
  const current = changes.find((c) => c.id === filters.change) ?? null;
  const canBulk = selectableIds(changes).length > 0;

  async function bulk(kind: "accept" | "dismiss") {
    setBusy(true);
    setErrors([]);
    const r = await runSequentially(selected, (id) =>
      kind === "accept" ? profile_changes_accept({ id }) : profile_changes_dismiss({ id }),
    );
    setBusy(false);
    setSelected(r.errors.map((e) => e.id));
    setErrors(r.errors.map((e) => `${changes.find((c) => c.id === e.id)?.locationName ?? e.id}: ${e.message}`));
    router.refresh();
  }

  async function one(fn: () => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>, revert = false) {
    setBusy(true);
    setErrors([]);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setErrors([`${r.error!.code}: ${r.error!.message}`]);
    if (revert) setProposed((r.data as { changeSetId: string }).changeSetId);
    router.refresh();
  }

  const actions = (c: ChangeData, size: "row" | "pane") => {
    const b = size === "row" ? btn : `${secondaryButtonClass} min-h-9 px-3`;
    return (
      <div className="flex flex-wrap gap-1.5">
        {c.can.accept && <button type="button" className={b} disabled={busy} onClick={() => one(() => profile_changes_accept({ id: c.id }))}>{t("accept")}</button>}
        {c.can.revert && <button type="button" className={b} disabled={busy} onClick={() => one(() => profile_changes_revert({ id: c.id }), true)}>{t("revert")}</button>}
        {c.can.dismiss && <button type="button" className={ghost} disabled={busy} onClick={() => one(() => profile_changes_dismiss({ id: c.id }))}>{t("dismiss")}</button>}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {canBulk && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={selected.length > 0 && selectableIds(changes).every((id) => selected.includes(id))}
              onChange={() => setSelected(toggleAllSelected(selected, changes))} />
            {t("selectAll")}
          </label>
          <span className="text-[13px] text-muted-foreground">{t("selectedCount", { count: selected.length })}</span>
          <button type="button" className={btn} disabled={busy || selected.length === 0} onClick={() => bulk("accept")}>{t("acceptSelected")}</button>
          <button type="button" className={ghost} disabled={busy || selected.length === 0} onClick={() => bulk("dismiss")}>{t("dismissSelected")}</button>
          <span className="text-xs text-muted-foreground">{t("revertOneAtATime")}</span>
        </div>
      )}
      {errors.map((e) => <CodeLine key={e} message={e} />)}
      {proposed && (
        <p aria-live="polite" className="text-[13px] text-good">
          {t("revertProposed")}{" "}
          <Link className={linkCls} href={approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: proposed }) })}>{t("openApprovals")}</Link>
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-x-auto rounded-xl border border-border">
          <table aria-label={t("changesTable")} className="w-full text-left text-[13px]">
            <thead className="bg-muted">
              <tr>
                <th scope="col" className={th}><span className="sr-only">{t("colSelect")}</span></th>
                <th scope="col" className={th}>{t("colLocation")}</th>
                <th scope="col" className={th}>{t("colChange")}</th>
                <th scope="col" className={th}>{t("colSource")}</th>
                <th scope="col" className={th}>{t("colFound")}</th>
                <th scope="col" className={th}>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => {
                const on = c.id === filters.change;
                const selectable = c.can.accept && c.can.dismiss;
                return (
                  <tr key={c.id} className={`border-t border-border align-top ${on ? "bg-brand-tint shadow-[inset_3px_0_0_var(--brand)]" : ""}`}>
                    <td className="px-3 py-2">
                      {selectable && (
                        <input type="checkbox" aria-label={t("selectChangeAria", { name: c.locationName })} checked={selected.includes(c.id)}
                          onChange={() => setSelected((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
                      )}
                    </td>
                    <td className="px-3 py-2 font-semibold">
                      <Link href={alertsHref(filters, { change: c.id })} className="hover:underline">{c.locationName}</Link>
                    </td>
                    <td className="px-3 py-2">
                      {changeSummary(c.fieldPaths)}
                      {c.revertChangeSetStatus && (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Pill tone={revertTone(c.revertChangeSetStatus)}>{revertLine(c.revertChangeSetStatus)}</Pill>
                          {c.revertChangeSetSurface === "mcp" && <ProvenanceChip surface="mcp" name={null} />}
                          {c.revertChangeSetSurface === "worker" && <Pill tone="info">{t("autoReverted")}</Pill>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {t(c.googleSuggested ? "sourceGoogle" : "sourceSnapshot")} {c.googleSuggested && !pubsubLive && <Pill tone="warn">{t("notLive")}</Pill>}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{foundCell(c.detectedAt, tf, c.workspaceId)}</td>
                    <td className="px-3 py-2">{actions(c, "row")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {current && (
          <section aria-label={t("selectedChange")} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
            <div>
              <h2 className="font-display text-lg font-bold">{current.locationName}</h2>
              <p className="text-[13px] text-muted-foreground">{foundLine(current, tf)}</p>
            </div>
            <ChangeDiff change={current} />
            {actions(current, "pane")}
            {current.can.revert && <p className="text-xs text-muted-foreground">{t("revertNote")}</p>}
            {(() => {
              const l = revertLink(current);
              return l ? <Link href={l.href} className={linkCls}>{l.label}</Link> : null;
            })()}
            <Link href={`/locations/${current.locationId}/changes`} className={linkCls}>{t("openLocation")}</Link>
          </section>
        )}
      </div>
    </div>
  );
}
