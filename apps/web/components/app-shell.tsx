"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { labelFor } from "../lib/i18n-labels";
import type { LiveStatus } from "../lib/live-status";
import { isNavItemActive, type NavGroup } from "../lib/nav";
import type { Density, Theme } from "../lib/preferences";
import type { ScopeOption } from "../lib/scope";
import type { ShellBrand } from "../lib/theme/brand";
import { AskPanel } from "./ask/ask-panel";
import { LegalLinks } from "./legal/legal-links";
import { CommandPalette, type SearchScope } from "./shell/command-palette";
import { NavIcon } from "./shell/icons";
import { LiveStatusBanner, LiveStatusPill } from "./shell/live-status";
import { ScopeSwitcher } from "./shell/scope-switcher";
import { UserMenu } from "./shell/user-menu";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function AppShell({
  email,
  orgLine,
  nav,
  commandNav,
  search,
  brand,
  status,
  banner,
  theme,
  density,
  bell,
  scope,
  ask,
  children,
}: {
  email: string;
  orgLine: string | null;
  nav: NavGroup[];
  commandNav: NavGroup[];
  search: { scope: SearchScope; profileTarget: { id: string; name: string } | null };
  brand: ShellBrand;
  /** Platform admins only; null for everyone else. */
  status: LiveStatus | null;
  banner: string | null;
  theme: Theme;
  density: Density;
  bell: ReactNode;
  scope: { options: ScopeOption[]; complete: boolean; current: ScopeOption } | null;
  /** Ask SynGMB: null hides it; `client` is the one client the scope names (null under All clients). */
  ask: { client: { id: string; name: string } | null } | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const t = useTranslations("shell");
  const tNav = useTranslations("nav");
  // The drawer is open for one pathname only, so navigating closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (next: boolean) => setOpenAt(next ? pathname : null);

  const menuButton = useRef<HTMLButtonElement>(null);
  // Set when Escape or the overlay closes the drawer; the header is inert until the re-render.
  const restoreFocus = useRef(false);
  const dismiss = () => {
    restoreFocus.current = true;
    setOpenAt(null);
  };

  useEffect(() => {
    if (!open) {
      if (restoreFocus.current) menuButton.current?.focus();
      restoreFocus.current = false;
      return;
    }
    document.querySelector<HTMLElement>("#app-nav a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div
      style={{ "--shell-top": banner ? "5.75rem" : "3.5rem" } as CSSProperties}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <div className="sticky top-0 z-30">
      <header inert={open} className="flex min-h-14 items-center gap-x-3 border-b border-border bg-card px-3 py-2 sm:px-5 lg:h-14">
        <button
          ref={menuButton}
          type="button"
          aria-label={t("menu")}
          aria-expanded={open}
          aria-controls="app-nav"
          onClick={() => setOpen(!open)}
          className={`inline-flex size-10 items-center justify-center rounded-control hover:bg-muted lg:hidden ${focus}`}
        >
          <Menu aria-hidden className="size-5" />
        </button>
        <Link
          href="/"
          aria-label={t("home", { name: brand.name })}
          className={`flex min-w-0 shrink-0 items-center gap-2.5 rounded-control lg:w-[212px] ${focus}`}
        >
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- agency-supplied https URL, not optimised by next/image
            <img src={brand.logoUrl} alt="" className="h-8 w-auto" />
          ) : (
            <span
              aria-hidden
              className="flex size-8 items-center justify-center rounded-[9px] bg-brand font-display text-[17px] font-extrabold text-brand-foreground"
            >
              {brand.mark}
            </span>
          )}
          <span className="hidden min-w-0 flex-col leading-4 sm:flex">
            <span className="truncate font-display text-[15px] font-extrabold" title={brand.name}>
              {brand.name}
            </span>
            <span className="truncate text-[11px] text-muted-foreground" title={brand.subline}>
              {brand.subline}
            </span>
          </span>
        </Link>
        {scope && (
          // useSearchParams needs a Suspense boundary outside it during prerender.
          <Suspense fallback={null}>
            <ScopeSwitcher options={scope.options} complete={scope.complete} current={scope.current} />
          </Suspense>
        )}
        <CommandPalette nav={commandNav} scope={search.scope} profileTarget={search.profileTarget} />
        <div className="ml-auto flex items-center gap-2">
          {status && <LiveStatusPill status={status} />}
          {ask && <AskPanel client={ask.client} />}
          {bell}
          <UserMenu email={email} orgLine={orgLine} theme={theme} density={density} />
        </div>
      </header>
        <LiveStatusBanner banner={banner} />
      </div>

      <div className="flex flex-1">
        {open && (
          <div aria-hidden className="fixed inset-0 z-30 bg-overlay/50 lg:hidden" onClick={dismiss} />
        )}
        <aside
          id="app-nav"
          className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-card transition-transform lg:sticky lg:top-(--shell-top) lg:z-auto lg:h-[calc(100vh-var(--shell-top))] lg:w-[232px] lg:shrink-0 lg:translate-x-0 ${
            open ? "translate-x-0" : "invisible -translate-x-full lg:visible"
          }`}
        >
          <nav aria-label={t("mainNav")} className="flex-1 overflow-y-auto px-3 py-4">
            {nav.map((g, i) => (
              <div key={g.label ?? i}>
                {g.label && (
                  <p className="px-2.5 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    {labelFor(tNav, "groups", g.label)}
                  </p>
                )}
                <ul className="flex flex-col gap-0.5">
                  {g.items.map((it) => {
                    const active = isNavItemActive(pathname, it);
                    return (
                      <li key={it.href}>
                        <Link
                          href={it.href}
                          aria-current={active ? "page" : undefined}
                          className={`flex h-9 items-center gap-2.5 rounded-[9px] px-2.5 text-sm ${focus} ${
                            active
                              ? "bg-brand-tint font-bold text-brand-text"
                              : "font-medium text-foreground hover:bg-muted"
                          }`}
                        >
                          <NavIcon
                            name={it.icon}
                            className={`size-[17px] shrink-0 ${active ? "text-brand" : "text-muted-foreground"}`}
                          />
                          {labelFor(tNav, "items", it.label)}
                          {it.badge ? (
                            <span
                              className={`ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold ${
                                it.urgent ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                              }`}
                            >
                              {it.badge > 99 ? "99+" : it.badge}
                              <span className="sr-only"> {it.badgeLabel ? labelFor(tNav, "badges", it.badgeLabel) : null}</span>
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="flex flex-col gap-0.5 border-t border-border px-5 py-4 text-xs">
            <span className="truncate text-muted-foreground" title={email}>
              {t("signedInAs", { email })}
            </span>
            {orgLine && <span className="font-semibold">{orgLine}</span>}
            <LegalLinks className="mt-2 justify-start text-xs" />
          </div>
        </aside>
        <main inert={open} className="min-w-0 flex-1 px-4 py-6 sm:px-7 sm:py-7">{children}</main>
      </div>
    </div>
  );
}
