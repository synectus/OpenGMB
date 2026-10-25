"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { reports_definitions_delete, reports_generate } from "../../app/_generated/actions";
import { TableWrap, tdClass, thClass } from "../page-parts";
import { Badge, ErrorText, linkClass } from "../ui";

export type DefinitionView = { id: string; name: string; kind: string; scope: string; period: string; language: string; email: string; emailOff: boolean; emailNotLive: boolean };

export function DefinitionsTable({ rows, canManage }: { rows: DefinitionView[]; canManage: boolean }) {
  const t = useTranslations("reports");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function call(p: Promise<{ ok: boolean; error?: { code: string; message: string } }>) {
    setError(null);
    const r = await p;
    if (!r.ok) return setError(`${r.error!.code}: ${r.error!.message}`);
    router.refresh();
  }
  return (
    <>
      <ErrorText message={error} />
      <TableWrap>
        <table className="w-full text-left text-sm" aria-label={canManage ? undefined : t("definitionsReadOnly")}>
          <thead className="border-b border-border bg-muted">
            <tr>
              {["colName", "colType", "colScope", "colPeriod", "colLanguage", "colMonthlyEmail"].map((h) => (
                <th key={h} scope="col" className={thClass}>{t(h)}</th>
              ))}
              {canManage && <th scope="col" className={thClass}><span className="sr-only">{t("actions")}</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((d) => (
              <tr key={d.id}>
                <td className={`${tdClass} font-semibold`}>{d.name}</td>
                <td className={tdClass}>{d.kind}</td>
                <td className={tdClass}>{d.scope}</td>
                <td className={tdClass}>{d.period}</td>
                <td className={tdClass}>{d.language}</td>
                <td className={tdClass}>
                  <span className={d.emailOff ? "text-muted-foreground" : ""}>{d.email}</span>{" "}
                  {d.emailNotLive && <Badge>{t("notLive")}</Badge>}
                </td>
                {canManage && (
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-3">
                      <Link href={`/reports/${d.id}/edit`} className={linkClass}>{t("edit")}</Link>
                      <button type="button" className={linkClass} onClick={() => call(reports_generate({ definitionId: d.id }))}>{t("generate")}</button>
                      <button
                        type="button"
                        className="text-sm font-semibold text-bad underline underline-offset-2"
                        onClick={() => {
                          if (window.confirm(t("confirmDelete", { name: d.name }))) {
                            void call(reports_definitions_delete({ id: d.id }));
                          }
                        }}
                      >
                        {t("delete")}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
