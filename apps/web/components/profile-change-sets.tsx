"use client";
import Link from "next/link";
import { statusLabel } from "../lib/labels";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { profileChangeSetsGet } from "@opengmb/core";
import { profile_apply, profile_cancel, profile_changeSets_get } from "../app/_generated/actions";
import { approvalsHref, itemKey } from "../lib/approvals";
import { endNote, resultRows, setMeta, setTitle, showsResults } from "../lib/bulk-edit";
import { ProvenanceChip } from "./approvals/provenance-chip";
import { useTimeFormat } from "./time-format-provider";
import { StatusBadge } from "./page-parts";
import { runCall } from "./post-card";
import { Violations } from "./reply-panel";
import { buttonClass, ErrorText, secondaryButtonClass } from "./ui";

export type ChangeSetData = Awaited<ReturnType<(typeof profileChangeSetsGet)["handler"]>>["changeSet"];

const POLL_MS = 1500;
const POLL_TRIES = 40;
const linkCls = "text-[13px] font-bold text-brand-text underline underline-offset-2 hover:text-foreground";

function ChangeSetCard({ initial }: { initial: ChangeSetData }) {
  const router = useRouter();
  const t = useTranslations("locationHub.sets");
  const tf = useTimeFormat();
  const [cs, setCs] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<{ ok: boolean }>, poll = false) {
    setBusy(true);
    setError(null);
    const r = await runCall<{ changeSet: ChangeSetData }>(fn as never);
    if ("error" in r) {
      setBusy(false);
      return setError(r.error);
    }
    setCs(r.data.changeSet);
    if (poll) {
      for (let i = 0; i < POLL_TRIES; i++) {
        await new Promise((res) => setTimeout(res, POLL_MS));
        const g = await runCall<{ changeSet: ChangeSetData }>(() => profile_changeSets_get({ id: cs.id }));
        if ("error" in g) break;
        setCs(g.data.changeSet);
        if (g.data.changeSet.status !== "queued") break;
      }
    }
    setBusy(false);
    router.refresh();
  }

  const note = endNote(cs);
  const drafted = cs.createdByName ? t("drafted", { name: cs.createdByName }) : null;
  return (
    <section aria-label={t("cardAria", { status: statusLabel(cs.status), title: setTitle(cs) })}
      className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={cs.status} />
        <span className="text-[13px] tabular-nums text-muted-foreground">{setMeta(cs, tf)}</span>
        <ProvenanceChip surface={cs.createdSurface} name={drafted} />
      </div>
      <strong className="text-sm">{setTitle(cs)}</strong>

      {cs.status === "pending_approval" && (
        <div className="flex flex-col gap-1">
          <Link href={approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: cs.id }) })} className={linkCls}>
            {t("reviewInApprovals")}
          </Link>
          {cs.can.approve && <span className="text-xs text-muted-foreground">{t("canApprove")}</span>}
        </div>
      )}
      {cs.status === "queued" && (
        <p role="status" className="rounded-control border border-info-border bg-info-bg px-3 py-2 text-[13px] text-info">
          {t("applying")}
        </p>
      )}
      {cs.status === "blocked" && cs.guardrail && <Violations result={cs.guardrail} />}
      {note && <p className="text-[13px] text-muted-foreground">{note}</p>}

      {showsResults(cs.status) && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-[13px]">
            <caption className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{t("resultsCaption")}</caption>
            <thead className="bg-muted">
              <tr>
                {(["colLocation", "colStatus", "colReason", "colFields"] as const).map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resultRows(cs).map((r, i) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-semibold">{r.location}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-2">
                    {r.code ? (<span className="text-bad" title={r.code}>{r.reason}</span>) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.fields}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ErrorText message={error} />
      {(cs.can.apply || cs.can.cancel) && (
        <div className="flex flex-wrap items-center gap-2">
          {cs.can.apply && (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => act(() => profile_apply({ id: cs.id }), true)}>
              {t("apply")}
            </button>
          )}
          {cs.can.cancel && (
            <>
              <button type="button" className={secondaryButtonClass} disabled={busy}
                onClick={() => {
                  if (window.confirm(t("cancelConfirm")))
                    void act(() => profile_cancel({ id: cs.id }));
                }}>
                {t("cancel")}
              </button>
              <span className="text-xs text-muted-foreground">{t("cancelNote")}</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Change sets of one workspace, newest first. Buttons come from core's `can` flags; approval is in /approvals. */
export function ProfileChangeSets({ changeSets, writesOff }: { changeSets: ChangeSetData[]; writesOff: boolean }) {
  const t = useTranslations("locationHub.sets");
  return (
    <div className="flex flex-col gap-3">
      {writesOff && (
        <p className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
          {t("writesOff")}
        </p>
      )}
      {changeSets.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-panel border border-dashed border-input bg-card px-6 py-8 text-center">
          <strong className="font-display">{t("empty")}</strong>
          <span className="text-sm text-muted-foreground">{t("emptyHint")}</span>
        </div>
      ) : (
        changeSets.map((c) => <ChangeSetCard key={c.id} initial={c} />)
      )}
    </div>
  );
}
