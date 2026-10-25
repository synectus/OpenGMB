"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { notifications_markRead } from "../../app/_generated/actions";
import { linkLabel } from "../../lib/notification-list";
import type { BellItem } from "../../lib/notifications";
import { useTimeFormat } from "../time-format-provider";
import { ErrorText, secondaryButtonClass } from "../ui";

export function MarkAllRead({ disabled }: { disabled: boolean }) {
  const t = useTranslations("settingsStatus.notifications");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    const r = await notifications_markRead({ all: true });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={onClick} disabled={disabled || pending} className={secondaryButtonClass}>
        {pending ? t("marking") : t("markAllRead")}
      </button>
      {pending && <p role="status" className="text-xs text-muted-foreground">{t("markingStatus")}</p>}
      <ErrorText message={error} />
    </div>
  );
}

export function NotificationList({ items }: { items: BellItem[] }) {
  const t = useTranslations("settingsStatus.notifications");
  const router = useRouter();
  const tf = useTimeFormat();
  const [error, setError] = useState<string | null>(null);

  async function open(item: BellItem) {
    setError(null);
    if (!item.readAt) {
      const r = await notifications_markRead({ ids: [item.id] });
      if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    }
    router.push(item.link!);
    router.refresh();
  }

  return (
    <>
      <ErrorText message={error} />
      <ul aria-label={t("listLabel")} className="flex flex-col">
        {items.map((item) => {
          const label = linkLabel(item.kind, item.link);
          return (
            <li key={item.id} className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
              <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-brand"}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`text-sm ${item.readAt ? "font-medium" : "font-bold"}`}>
                  {!item.readAt && <span className="sr-only">{t("unreadPrefix")}</span>}
                  {item.title}
                </span>
                <span className="text-xs text-muted-foreground">{tf.dateTime(item.createdAt)}</span>
              </div>
              {label && (
                <Link
                  href={item.link!}
                  onClick={(e) => {
                    e.preventDefault();
                    void open(item);
                  }}
                  className="shrink-0 text-sm font-semibold text-brand-text underline-offset-2 hover:underline"
                >
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
