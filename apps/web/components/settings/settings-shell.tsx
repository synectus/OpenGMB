import Link from "next/link";
import type { ReactNode } from "react";
import { billingMode, isPlatformAdmin, roleHasPermission, type Role } from "@opengmb/core";
import { getDb } from "../../lib/auth";
import { getTranslations } from "next-intl/server";
import { requireUser } from "../../lib/guard";
import { settingsNavFor } from "../../lib/settings-nav";
import { PageHeader } from "../ui";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The frame of every settings page: h1, description, the Settings sub-nav (only pages the role can open) and the content.
 * Nothing here may carry role="status": /audit's smoke test needs its own to be the only one.
 */
export async function SettingsShell({
  current,
  role,
  title,
  description,
  children,
}: {
  /** The sub-nav href of this page, e.g. "/settings/google" or "/audit". */
  current: string;
  role: Role | null;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const t = await getTranslations("settings");
  const { userId } = await requireUser();
  const items = settingsNavFor(
    (p) => roleHasPermission(role, p),
    await isPlatformAdmin(getDb(), userId),
    billingMode() === "hosted",
  );
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader title={title} description={description} />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav aria-label={t("shell.navLabel")} className="lg:w-[220px] lg:shrink-0">
          <ul className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
            {items.map((it) => {
              const here = it.href === current;
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={here ? "page" : undefined}
                    className={`flex h-9 items-center rounded-[9px] px-3 text-sm ${focus} ${
                      here
                        ? "bg-brand-tint font-bold text-brand-text"
                        : "font-medium text-foreground hover:bg-muted"
                    }`}
                  >
                    {it.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}
