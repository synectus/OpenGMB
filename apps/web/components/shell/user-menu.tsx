"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { setDensity, setLanguage, setTheme } from "../../lib/preferences-actions";
import { LOCALES, LOCALE_NAMES, parseLocale } from "../../lib/i18n";
import { parseTheme, type Density, type Theme } from "../../lib/preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { signOut } from "../sign-out-button";

export function UserMenu({
  email,
  orgLine,
  theme,
  density,
}: {
  email: string;
  orgLine: string | null;
  theme: Theme;
  density: Density;
}) {
  const router = useRouter();
  const t = useTranslations("shell");
  const locale = useLocale();
  const [, startTransition] = useTransition();

  function onTheme(value: string) {
    const next = parseTheme(value);
    // Apply at once; the cookie makes it stick across reloads.
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    startTransition(async () => {
      await setTheme(next);
      router.refresh();
    });
  }

  function onDensity(value: string) {
    startTransition(async () => {
      await setDensity(value);
      router.refresh();
    });
  }

  function onLanguage(value: string) {
    startTransition(async () => {
      await setLanguage(parseLocale(value));
      router.refresh();
    });
  }

  // Not modal: a modal menu aria-hides the whole page while open, which axe reports as aria-hidden-focus
  // (the page stays tabbable). Tab closes the menu instead.
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("accountMenu")}
          className="inline-flex size-[38px] items-center justify-center rounded-full bg-foreground text-[13px] font-bold text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {email.charAt(0).toUpperCase()}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate">{email}</span>
          {orgLine && <span className="text-xs font-normal text-muted-foreground">{orgLine}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">{t("account")}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/help">{t("helpCenter")}</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("theme")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={onTheme}>
          <DropdownMenuRadioItem value="light">{t("light")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t("dark")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t("system")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("density")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={onDensity}>
          <DropdownMenuRadioItem value="compact">{t("compact")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable">{t("comfortable")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("language")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={onLanguage}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => void signOut()}>
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
