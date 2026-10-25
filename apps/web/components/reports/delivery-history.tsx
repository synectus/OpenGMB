"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { reports_share_revoke } from "../../app/_generated/actions";
import { StatusBadge, TableWrap, tdClass, thClass } from "../page-parts";
import { ErrorText, linkClass } from "../ui";
import { ShareBox } from "./share-box";

export type RunView = {
  id: string;
  workspaceId?: string;
  title: string; // "Monthly performance · September 2026", for the share box
  name: string;
  period: string;
  trigger: string;
  status: string;
  wait: string | null;
  error: string | null;
  hint: string | null;
  emailed: string;
  link: { text: string; revokeId: string | null; note: string | null };
};

export function DeliveryHistory({ rows, canManage, expiryOptions, defaultDays }: { rows: RunView[]; canManage: boolean; expiryOptions: number[]; defaultDays: number }) {
  const t = useTranslations("reports");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<RunView | null>(null);
  async function revoke(linkId: string) {
    if (!window.confirm(t("confirmRevoke"))) return;
    setError(null);
    const r = await reports_share_revoke({ linkId });
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.refresh();
  }
  return (
    <div className="flex flex-col gap-3">
      <ErrorText message={error} />
      {sharing && <ShareBox key={sharing.id} runId={sharing.id} title={sharing.title} workspaceId={sharing.workspaceId} options={expiryOptions} defaultDays={defaultDays} onClose={() => setSharing(null)} />}
      <TableWrap>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted">
            <tr>
              {["colReport", "colPeriod", "colTrigger", "colStatus", "colEmailed", "colShareLink"].map((h) => (
                <th key={h} scope="col" className={thClass}>{t(h)}</th>
              ))}
              <th scope="col" className={thClass}><span className="sr-only">{t("actions")}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={`${tdClass} font-semibold`}>{r.name}</td>
                <td className={`${tdClass} whitespace-nowrap`}>{r.period}</td>
                <td className={tdClass}>{r.trigger}</td>
                <td className={tdClass}>
                  <div className="flex flex-col gap-1">
                    <StatusBadge status={r.status} />
                    {r.wait && <span className="text-xs text-muted-foreground">{r.wait}</span>}
                    {r.error && <span className="text-xs text-bad">{r.error}</span>}
                    {r.hint && <span className="text-xs text-muted-foreground">{r.hint}</span>}
                  </div>
                </td>
                <td className={`${tdClass} text-muted-foreground`}>{r.emailed}</td>
                <td className={tdClass}>
                  <div className="flex flex-col gap-1">
                    <span className="flex gap-2">
                      {r.link.text}
                      {canManage && r.link.revokeId && (
                        <button type="button" className="text-sm font-semibold text-bad underline underline-offset-2" onClick={() => revoke(r.link.revokeId!)}>{t("revoke")}</button>
                      )}
                    </span>
                    {r.link.note && <span className="text-xs text-muted-foreground">{r.link.note}</span>}
                  </div>
                </td>
                <td className={tdClass}>
                  {r.status === "done" && (
                    <div className="flex flex-wrap gap-3">
                      <a href={`/api/reports/${r.id}/download`} className={linkClass}>{t("downloadPdf")}</a>
                      {canManage && <button type="button" className={linkClass} onClick={() => setSharing(r)}>{t("shareTitle")}</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
