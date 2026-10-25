"use client";
import { LoaderCircle } from "lucide-react";
import { guardrailLabel } from "@/lib/labels";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { profile_changeSets_list } from "../../app/_generated/actions";
import { approvalsHref, formatApprovalTime } from "../../lib/approvals";
import { fieldName, reasonText } from "../../lib/profile-editor";
import { ProvenanceChip } from "../approvals/provenance-chip";
import { useTimeFormat } from "../time-format-provider";
import { StatusBadge } from "../page-parts";
import type { profileChangeSetsGet } from "@opengmb/core";
import { runCall } from "../post-card";
import { linkClass, secondaryButtonClass } from "../ui";
import { h2Class, sectionClass, usePhrase } from "./section";

/** Defined here, not imported from profile-change-sets.tsx, which plan 3G rewrites. */
export type ChangeSetData = Awaited<ReturnType<(typeof profileChangeSetsGet)["handler"]>>["changeSet"];

const SHOWN = new Set(["pending_approval", "approved", "queued", "failed", "partially_applied", "blocked"]);
const MAX_ROWS = 5;
const POLL_MS = 1500;
const POLL_TRIES = 40;
const infoRow = "flex items-center gap-2 rounded-lg bg-info-bg px-3 py-2 text-sm font-semibold text-info";

/** Change sets that target this location and still need someone, newest first. Polls while one is queued. */
export function OpenChangeSets({
  initial,
  locationId,
  onPreviewAgain,
}: {
  initial: ChangeSetData[];
  locationId: string;
  onPreviewAgain?: () => void;
}) {
  const tf = useTimeFormat();
  const t = useTranslations("profile");
  const phrase = usePhrase();
  const [sets, setSets] = useState(initial);
  const shown = sets.filter((c) => SHOWN.has(c.status)).slice(0, MAX_ROWS);
  const queued = shown.some((c) => c.status === "queued");

  useEffect(() => {
    if (!queued) return;
    let stop = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop || tries++ >= POLL_TRIES) return;
      const r = await runCall<{ changeSets: ChangeSetData[] }>(() =>
        profile_changeSets_list({ locationId, limit: 10 }),
      );
      if (stop) return;
      if ("data" in r) setSets(r.data.changeSets);
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [queued, locationId]);

  if (shown.length === 0) return null;
  return (
    <section aria-label={t("changeSets.title")} className={sectionClass}>
      <h2 className={h2Class}>{t("changeSets.title")}</h2>
      <ul className="flex flex-col gap-2">
        {shown.map((cs) => {
          const target = cs.targets.find((x) => x.locationId === locationId);
          const fields = [...Object.keys(cs.fields.fields), ...Object.keys(cs.fields.attributes)]
            .map((f) => phrase(fieldName(f)))
            .join(", ");
          const blocked = cs.guardrail?.violations.filter((v) => v.severity === "block") ?? [];
          return (
            <li key={cs.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={cs.status} />
                <strong className="text-sm">{fields}</strong>
                <ProvenanceChip surface={cs.createdSurface} name={null} />
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatApprovalTime(tf, cs.createdAt, cs.workspaceId)}</span>
              </div>
              {cs.status === "pending_approval" && (
                <Link className={linkClass} href={approvalsHref({ tab: "changeset", item: `changeset:${cs.id}` })}>
                  {t("openApprovals")}
                </Link>
              )}
              {cs.status === "approved" && (
                <p className="text-sm">
                  {t.rich("changeSets.approved", {
                    link: (chunks) => (
                      <Link className={linkClass} href={`/locations/bulk-edit?ws=${cs.workspaceId}#change-sets`}>
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
              )}
              {cs.status === "queued" && (
                <>
                  <strong className="text-sm">{t("changeSets.applying")}</strong>
                  <p role="status" className={infoRow}>
                    <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
                    {t("changeSets.waiting")}
                  </p>
                </>
              )}
              {target?.error && (
                <p role="alert" className="text-sm text-bad">
                  {reasonText(target.error)}
                </p>
              )}
              {target?.error === "conflict" && onPreviewAgain && (
                <div>
                  <button type="button" className={secondaryButtonClass} onClick={onPreviewAgain}>
                    {t("changeSets.previewAgain")}
                  </button>
                </div>
              )}
              {cs.status === "blocked" && blocked.length > 0 && (
                <p className="text-sm text-bad">{t("changeSets.blocked", { list: [...new Set(blocked.map((v) => guardrailLabel(v.ruleId, v.message)))].join(", ") })}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
