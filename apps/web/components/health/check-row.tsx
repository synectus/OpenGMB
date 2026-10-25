import Link from "next/link";
import { useTranslations } from "next-intl";
import { plainText } from "../../lib/labels";
import type { ReactNode } from "react";
import type { CheckRow as Row } from "../../lib/health";
import type { TimeFormat } from "../../lib/time-format";
import { linkClass } from "../ui";

const STATUS = {
  pass: { cls: "text-good", d: "M20 6 9 17l-5-5" },
  fail: { cls: "text-bad", d: "M6 6l12 12M18 6 6 18" },
  unknown: { cls: "text-foreground", d: "M6 12h12" },
  skipped: { cls: "text-muted-foreground", d: "M6 12h12" },
} as const;
const IMP = { necessary: "bg-bad-bg text-bad", important: "bg-warn-bg text-warn", nice: "bg-secondary text-secondary-foreground" } as const;

export function CheckRow({
  c,
  canManage,
  action,
  tf,
  ws,
}: {
  c: Row;
  canManage: boolean;
  action?: ReactNode;
  tf: TimeFormat;
  ws?: string;
}) {
  const t = useTranslations("locationHub.health");
  const s = STATUS[c.status];
  const failing = c.status === "fail";
  return (
    <li
      className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${
        failing ? "border-l-4 border-l-brand bg-brand-tint" : c.status === "skipped" ? "bg-muted" : ""
      }`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1 text-sm font-semibold ${s.cls}`}>
            <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path d={s.d} />
            </svg>
            {t(`status.${c.status}`)}
          </span>
          <span className="text-sm font-semibold text-foreground">{c.title}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${IMP[c.importance]}`}>{t(`importance.${c.importance}`)}</span>
        </div>
        <p className="text-sm text-muted-foreground">{c.skipped ? t("skippedBy", { name: c.skipped.byName ?? t("skippedByUnknown"), date: tf.date(c.skipped.at, ws) }) : plainText(c.detail)}</p>
        {failing && !canManage && <p className="text-xs text-muted-foreground">{t("askFix")}</p>}
      </div>
      {canManage && (failing || c.status === "skipped") && (
        <div className="flex items-center gap-3">
          {failing && c.fix && (
            <Link href={c.fix.href} className={linkClass}>
              {c.fix.label}
            </Link>
          )}
          {action}
        </div>
      )}
    </li>
  );
}
