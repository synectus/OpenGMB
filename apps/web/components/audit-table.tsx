"use client";
import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";
import { actorLabel, auditName, changeJson, surfaceLabel } from "../lib/audit-view";
import { useTimeFormat } from "./time-format-provider";
import { Pill, TableWrap, tdClass, thClass } from "./page-parts";

export type AuditRow = {
  id: number;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorType: string;
  surface: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
};

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const t = useTranslations("audit.table");
  const tf = useTimeFormat();
  const [open, setOpen] = useState<number[]>([]);
  const toggle = (id: number) =>
    setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  return (
    <TableWrap>
      <table className="w-full min-w-[760px] text-left text-sm">
        <caption className="sr-only">{t("caption")}</caption>
        <thead className="border-b border-border bg-muted">
          <tr>
            <th scope="col" className={thClass}>{t("id")}</th>
            <th scope="col" className={thClass}>{t("when")}</th>
            <th scope="col" className={thClass}>{t("actor")}</th>
            <th scope="col" className={thClass}>{t("surface")}</th>
            <th scope="col" className={thClass}>{t("action")}</th>
            <th scope="col" className={thClass}>{t("entity")}</th>
            <th scope="col" className={thClass}>
              <span className="sr-only">{t("change")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((e) => {
            const isOpen = open.includes(e.id);
            return (
              <Fragment key={e.id}>
                <tr>
                  <td className={`${tdClass} tabular-nums`}>{e.id}</td>
                  <td className={`${tdClass} whitespace-nowrap tabular-nums`}>
                    {tf.dateTime(e.createdAt)}
                  </td>
                  <td className={`${tdClass} break-all`}>{actorLabel(e)}</td>
                  <td className={tdClass}>
                    <Pill>{surfaceLabel(e.surface)}</Pill>
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>{auditName(e.action)}</td>
                  <td className={`${tdClass} break-all`}>
                    {auditName(e.entityType)} {e.entityId}
                  </td>
                  <td className={tdClass}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`change-${e.id}`}
                      onClick={() => toggle(e.id)}
                      className="whitespace-nowrap text-sm font-semibold text-brand-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {isOpen ? t("hide") : t("show")}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr id={`change-${e.id}`}>
                    <td colSpan={7} className="bg-muted px-3 py-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        {(["before", "after"] as const).map((side) => (
                          <div key={side} className="flex min-w-0 flex-col gap-1">
                            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {side === "before" ? t("before") : t("after")}
                            </span>
                            <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-control border border-border bg-card p-3 font-mono text-xs">
                              {changeJson(e[side])}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
