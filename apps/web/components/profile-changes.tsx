"use client";
import Link from "next/link";
import { profileFieldsLabel, statusWords } from "../lib/labels";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  profile_changes_accept,
  profile_changes_dismiss,
  profile_changes_revert,
} from "../app/_generated/actions";
import { approvalsHref, itemKey } from "../lib/approvals";
import {
  CHANGE_TONE,
  revertLink,
  revertTone,
  type ChangeData,
} from "../lib/changes";
import { ProvenanceChip } from "./approvals/provenance-chip";
import { ChangeDiff } from "./changes/change-diff";
import { Pill } from "./page-parts";
import { runCall } from "./post-card";
import { useTimeFormat } from "./time-format-provider";
import { secondaryButtonClass } from "./ui";

export type { ChangeData };

const btn = `${secondaryButtonClass} min-h-9 px-3`;
const ghost =
  "inline-flex min-h-9 items-center rounded-control px-3 text-sm font-semibold text-secondary-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkCls = "text-[13px] font-bold text-brand-text underline underline-offset-2 hover:text-foreground";

function ErrorLine({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  const t = useTranslations("locationHub.changes");
  const at = message.indexOf(":");
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-[13px] text-bad">
        <span className="font-mono">{message.slice(0, at)}</span>
        {message.slice(at)}
      </p>
      <button type="button" className={btn} onClick={onRefresh}>{t("refresh")}</button>
    </div>
  );
}

function RevertState({ change, writesOff }: { change: ChangeData; writesOff: boolean }) {
  const t = useTranslations("locationHub.changes");
  if (!change.revertChangeSetStatus) return null;
  const link = revertLink(change);
  const rs = change.revertChangeSetStatus;
  const status = t.has(`revertStatus.${rs}`) ? t(`revertStatus.${rs}`) : statusWords(rs);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <Pill tone={revertTone(change.revertChangeSetStatus)}>{t(rs === "queued" ? "revertLineQueued" : "revertLine", { status })}</Pill>
      {change.revertChangeSetSurface === "mcp" && <ProvenanceChip surface="mcp" name={null} />}
      {change.revertChangeSetSurface === "worker" && <Pill tone="info">{t("autoReverted")}</Pill>}
      {writesOff && change.revertChangeSetStatus === "approved" && (
        <span className="text-muted-foreground">{t("writesOffFail")}</span>
      )}
      {link && <Link href={link.href} className={linkCls}>{link.href.startsWith("/approvals") ? t("openApprovals") : t("openChangeSets")}</Link>}
    </div>
  );
}

function OpenChange({ change, pubsubLive }: { change: ChangeData; pubsubLive: boolean }) {
  const router = useRouter();
  const t = useTranslations("locationHub.changes");
  const tf = useTimeFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposed, setProposed] = useState<string | null>(null);

  async function act(fn: () => Promise<{ ok: boolean }>, after?: (d: { changeSetId?: string }) => void) {
    setBusy(true);
    setError(null);
    const r = await runCall<{ changeSetId?: string }>(fn as never);
    setBusy(false);
    if ("error" in r) return setError(r.error);
    after?.(r.data);
    router.refresh();
  }

  const g = change.googleSuggested;
  return (
    <section
      aria-label={g ? t("openGoogleAria") : t("openSnapshotAria")}
      className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={CHANGE_TONE.open}>{t("open")}</Pill>
        {g && <Pill tone="info">{t("googleSuggested")}</Pill>}
        {g && !pubsubLive && <Pill tone="warn">{t("notLive")}</Pill>}
        <span className="text-[13px] text-muted-foreground">{t("found", { when: tf.dateTime(change.detectedAt, change.workspaceId), source: t(`source.${change.source}`) })}</span>
      </div>
      <strong className="text-sm">
        {g ? t("googleHeadline") : t("outsideHeadline")}
      </strong>
      <ChangeDiff change={change} />
      {proposed ? (
        <p aria-live="polite" className="text-[13px] text-good">
          {t("revertProposed")}{" "}
          <Link href={approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: proposed }) })} className={linkCls}>
            {t("openApprovals")}
          </Link>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {change.can.accept && (
            <button type="button" className={btn} disabled={busy} onClick={() => act(() => profile_changes_accept({ id: change.id }))}>
              {t("accept")}
            </button>
          )}
          {change.can.revert && (
            <button type="button" className={btn} disabled={busy}
              onClick={() => act(() => profile_changes_revert({ id: change.id }), (d) => setProposed(d.changeSetId ?? null))}>
              {t("revert")}
            </button>
          )}
          {change.can.dismiss && (
            <button type="button" className={ghost} disabled={busy} onClick={() => act(() => profile_changes_dismiss({ id: change.id }))}>
              {t("dismiss")}
            </button>
          )}
        </div>
      )}
      {error && <ErrorLine message={error} onRefresh={() => router.refresh()} />}
      {g ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("googleNote")}
          </p>
          {!pubsubLive && (
            <p className="text-xs text-muted-foreground">{t("noPubsub")}</p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("snapshotNote")}
        </p>
      )}
    </section>
  );
}

function ResolvedChange({ change, writesOff }: { change: ChangeData; writesOff: boolean }) {
  const t = useTranslations("locationHub.changes");
  const tf = useTimeFormat();
  const fields = profileFieldsLabel(change.fieldPaths);
  const who = change.resolvedByName ?? t("teamMember");
  const resolved =
    change.status === "accepted" || change.status === "dismissed"
      ? t(`${change.status}By${change.resolvedAt ? "On" : ""}`, { name: who, date: change.resolvedAt ? tf.date(change.resolvedAt, change.workspaceId) : "" })
      : null;
  if (change.status === "reverted") {
    // The revert state stays visible while the diff is collapsed, as on the board.
    return (
      <section aria-label={t("revertedAria")} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p)">
        <details>
          <summary aria-label={t("expandAria", { fields })} className="flex cursor-pointer flex-wrap items-center gap-2 focus-visible:outline-2 focus-visible:outline-ring">
            <Pill tone={CHANGE_TONE.reverted}>{t("reverted")}</Pill>
            <span className="text-[13px] text-muted-foreground">{t("found", { when: tf.dateTime(change.detectedAt, change.workspaceId), source: t(`source.${change.source}`) })}</span>
            <span className="text-xs font-semibold">{fields}</span>
          </summary>
          <div className="mt-3">
            <ChangeDiff change={change} />
          </div>
        </details>
        <RevertState change={change} writesOff={writesOff} />
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-panel border border-border bg-card p-(--panel-p)">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={CHANGE_TONE[change.status]}>{t(change.status === "dismissed" ? "dismissed" : "accepted")}</Pill>
        <span className="text-xs font-semibold">{fields}</span>
      </div>
      <span className="text-[13px] text-muted-foreground">{resolved}</span>
    </div>
  );
}

/** The location's change list. Which buttons show comes from core's `can` flags. */
export function ProfileChanges({
  changes,
  writesOff,
  pubsubLive,
}: {
  changes: ChangeData[];
  writesOff: boolean;
  pubsubLive: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {changes.map((c) =>
        c.status === "open" ? (
          <OpenChange key={c.id} change={c} pubsubLive={pubsubLive} />
        ) : (
          <ResolvedChange key={c.id} change={c} writesOff={writesOff} />
        ),
      )}
    </div>
  );
}
