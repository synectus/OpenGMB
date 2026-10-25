"use client";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { notifications_markRead } from "../app/_generated/actions";
import type { BellData, BellItem } from "../lib/notifications";
import { ErrorText } from "./ui";

type T = ReturnType<typeof useTranslations<"notifications">>;

function relativeTime(t: T, iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return t("justNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("minutesAgo", { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("hoursAgo", { count: h });
  return t("daysAgo", { count: Math.floor(h / 24) });
}

export function NotificationBell({ initial, allHref }: { initial: BellData; allHref?: string }) {
  const t = useTranslations("notifications");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { unreadCount, items } = initial;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(input: { ids: string[] } | { all: true }) {
    setError(null);
    const result = await notifications_markRead(input);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return false;
    }
    return true;
  }

  async function onItem(item: BellItem) {
    if (!item.readAt && !(await markRead({ ids: [item.id] }))) return;
    setOpen(false);
    if (item.link) router.push(item.link);
    router.refresh();
  }

  async function onMarkAll() {
    if (await markRead({ all: true })) router.refresh();
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={t("buttonLabel", { count: unreadCount })}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex size-[38px] items-center justify-center rounded-control border border-border bg-card text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Bell aria-hidden className="size-[18px]" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-bold text-destructive-foreground"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-panel border border-border bg-popover text-popover-foreground shadow-popover">
          <div className="flex items-center justify-between border-b border-input px-3 py-2">
            <span className="text-sm font-medium">{t("title")}</span>
            <button
              type="button"
              onClick={onMarkAll}
              disabled={unreadCount === 0}
              className="text-sm underline disabled:opacity-50"
            >
              {t("markAllRead")}
            </button>
          </div>
          <ErrorText message={error} />
          {items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onItem(item)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-secondary"
                  >
                    <span className={item.readAt ? "text-muted-foreground" : "font-semibold"}>
                      {!item.readAt && <span className="sr-only">{t("unread")} </span>}
                      {item.title}
                    </span>
                    <span className="text-xs text-muted-foreground">{relativeTime(t, item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {allHref && (
            <div className="border-t border-input px-3 py-2">
              <Link
                href={allHref}
                onClick={() => setOpen(false)}
                className="text-sm font-semibold text-brand-text underline-offset-2 hover:underline"
              >
                {t("all")}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
