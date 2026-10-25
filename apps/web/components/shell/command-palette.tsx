"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import type { searchEverything } from "@opengmb/core";
import { search_everything } from "../../app/_generated/actions";
import { labelFor } from "../../lib/i18n-labels";
import type { NavGroup } from "../../lib/nav";
import {
  PROFILE_SECTIONS,
  SEARCH_MIN_CHARS,
  locationHref,
  postHref,
  profileSectionHref,
  reviewHref,
} from "../../lib/search-targets";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../primitives/command";
import { NavIcon } from "./icons";

type Found = Awaited<ReturnType<(typeof searchEverything)["handler"]>>;
const NONE: Found = { locations: [], reviews: [], posts: [] };

/** What the top-bar scope switcher is set to, in the shape search.everything takes. */
export type SearchScope = { workspaceId?: string; groupId?: string; locationIds?: string[] };

export function CommandPalette({
  nav,
  scope = {},
  profileTarget = null,
}: {
  nav: NavGroup[];
  scope?: SearchScope;
  /** The location whose Profile the section results open: the scope's, else the first in scope. */
  profileTarget?: { id: string; name: string } | null;
}) {
  const t = useTranslations("search");
  const tNav = useTranslations("nav");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The answer to one query. An answer for an older query is ignored, so typing on never shows stale hits.
  const [answer, setAnswer] = useState<{ key: string; found: Found | null } | null>(null);
  const router = useRouter();
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim();
  const key = `${q}\n${scopeKey}`;
  useEffect(() => {
    if (q.length < SEARCH_MIN_CHARS) return;
    let current = true;
    const timer = setTimeout(async () => {
      const r = await search_everything({ q, ...(JSON.parse(scopeKey) as SearchScope) });
      if (current) setAnswer({ key, found: r.ok ? (r.data as Found) : null });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, scopeKey, key]);

  const asked = q.length >= SEARCH_MIN_CHARS;
  const answered = asked && answer?.key === key;
  const found = answered && answer.found ? answer.found : NONE;
  const state: "idle" | "searching" | "failed" = !asked || (answered && answer.found) ? "idle" : answered ? "failed" : "searching";

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const stars = (n: number | null) => (n === null ? t("noRating") : t("stars", { count: n }));
  // The server already matched these, so each one carries the typed text in its value to pass cmdk's own filter.
  const hits = found.locations.length + found.reviews.length + found.posts.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("search")}
        className="flex size-[38px] shrink-0 items-center justify-center gap-2 rounded-control border border-border bg-muted text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring sm:h-[38px] sm:w-auto sm:min-w-[240px] sm:max-w-[420px] sm:flex-1 sm:justify-start sm:px-3"
      >
        <Search aria-hidden className="size-4" />
        <span className="hidden flex-1 text-left sm:inline">{t("search")}</span>
        <kbd className="hidden rounded border border-input px-1.5 text-[11px] font-semibold sm:inline">⌘K</kbd>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={close}
        title={t("search")}
        description={t("description")}
      >
        <CommandInput
          placeholder={t("placeholder")}
          aria-label={t("inputLabel")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>{state === "searching" ? t("searching") : t("nothing")}</CommandEmpty>
          {nav.map((g, i) => (
            <CommandGroup key={g.label ?? i} heading={g.label ? labelFor(tNav, "groups", g.label) : t("pages")}>
              {g.items.map((it) => (
                <CommandItem key={it.href} value={`${g.label ?? ""} ${it.label} ${labelFor(tNav, "items", it.label)}`} onSelect={() => go(it.href)}>
                  <NavIcon name={it.icon} className="size-4" />
                  {labelFor(tNav, "items", it.label)}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {profileTarget && q.length > 0 && (
            <CommandGroup heading={t("profileSections")}>
              {PROFILE_SECTIONS.map((s) => (
                <CommandItem
                  key={s.label}
                  value={`Profile ${s.label} ${s.words}`}
                  onSelect={() => go(profileSectionHref(profileTarget.id, s.label))}
                >
                  <span>{s.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{t("profileOf", { name: profileTarget.name })}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {found.locations.length > 0 && (
            <CommandGroup heading={tNav("items.Locations")}>
              {found.locations.map((l) => (
                <CommandItem key={l.id} value={`${q} location ${l.id}`} onSelect={() => go(locationHref(l.id))}>
                  <span className="truncate">{l.title ?? l.name}</span>
                  {l.addressSummary && <span className="truncate text-xs text-muted-foreground">{l.addressSummary}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {found.reviews.length > 0 && (
            <CommandGroup heading={tNav("items.Reviews")}>
              {found.reviews.map((r) => (
                <CommandItem key={r.id} value={`${q} review ${r.id}`} onSelect={() => go(reviewHref(r.id))}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{r.snippet ?? t("noText")}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {stars(r.rating)} · {r.reviewer ?? t("anonymous")} · {r.locationName}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {found.posts.length > 0 && (
            <CommandGroup heading={tNav("items.Posts")}>
              {found.posts.map((p) => (
                <CommandItem key={p.id} value={`${q} post ${p.id}`} onSelect={() => go(postHref(p.id))}>
                  <span className="truncate">{p.snippet}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        {/* Outside the listbox: only options and groups may be its children (aria-required-children). */}
        <div role="status" aria-live="polite" className="sr-only">
          {state === "failed" ? t("unavailableShort") : state === "idle" && q.length >= SEARCH_MIN_CHARS ? t("results", { count: hits }) : ""}
        </div>
        {state === "failed" && <p className="px-3 py-2 text-sm text-muted-foreground">{t("unavailable")}</p>}
      </CommandDialog>
    </>
  );
}
