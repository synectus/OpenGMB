"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, LayoutGrid } from "lucide-react";
import { setScope } from "../../lib/preferences-actions";
import { findScopeOptions, scopeOptionForValue } from "../../lib/scope-actions";
import { afterScopeChangeHref, urlScopeValue, type ScopeOption } from "../../lib/scope";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../primitives/command";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const INDENT = ["pl-2", "pl-2.5", "pl-6.5"] as const;

/**
 * `options` is the whole list for a short account (`complete`), else All clients and the first clients:
 * the rest is searched and paged on the server when the list opens (H4), so a long account does not
 * send one entry per location with every page. `current` is the option for the cookie scope.
 */
export function ScopeSwitcher({
  options,
  complete,
  current: serverCurrent,
}: {
  options: ScopeOption[];
  complete: boolean;
  current: ScopeOption;
}) {
  const t = useTranslations("scope");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; options: ScopeOption[]; more: boolean } | null>(null);
  const [paging, setPaging] = useState(false);
  const [fromUrl, setFromUrl] = useState<ScopeOption | null>(null);
  const latest = useRef(0);

  // A ?ws= link names the scope its page shows. A short list has it already; a long one asks the server.
  const urlValue = urlScopeValue(params.get("ws"));
  const known = urlValue ? [serverCurrent, ...options].find((o) => o.value === urlValue) : undefined;
  useEffect(() => {
    if (complete || !urlValue || known || fromUrl?.value === urlValue) return;
    let live = true;
    void scopeOptionForValue(urlValue).then((o) => live && setFromUrl(o));
    return () => {
      live = false;
    };
  }, [complete, urlValue, known, fromUrl]);
  const current = known ?? (fromUrl && fromUrl.value === urlValue ? fromUrl : serverCurrent);
  const shown = current.value;

  // A long list: fetch the first page on open and again, after a short pause, as the text changes.
  useEffect(() => {
    if (complete || !open) return;
    const ticket = ++latest.current;
    const t = setTimeout(() => {
      void findScopeOptions(query, 0).then((r) => {
        if (ticket !== latest.current) return;
        setFound({ q: query, ...r });
      });
    }, query ? 200 : 0);
    return () => clearTimeout(t);
  }, [complete, open, query]);

  function more() {
    if (!found) return;
    const ticket = latest.current;
    setPaging(true);
    void findScopeOptions(query, found.options.length).then((r) => {
      if (ticket !== latest.current) return;
      setFound({ q: query, options: [...found.options, ...r.options], more: r.more });
      setPaging(false);
    });
  }

  function choose(next: string) {
    setOpen(false);
    startTransition(async () => {
      await setScope(next);
      router.replace(afterScopeChangeHref(pathname, params.toString()));
      router.refresh();
    });
  }

  // Fetching: the list on screen is not yet the answer to the text in the box.
  const loading = !complete && open && (found === null || found.q !== query);
  const list = complete ? options : (found?.options ?? options);
  const [all, ...rest] = list;
  const showAll = all && all.value === "all";
  const clients = showAll ? rest : list;

  // "All clients" is the one label this list makes up itself; client and location names are data.
  const labelOf = (o: ScopeOption) => (o.value === "all" ? t("allClients") : o.label);
  const item = (o: ScopeOption) => (
    <CommandItem key={o.value} value={o.search} onSelect={() => choose(o.value)} className={`gap-2 ${INDENT[o.depth]}`}>
      <span className={`min-w-0 flex-1 truncate ${o.depth < 2 ? "font-semibold" : "font-medium"}`}>{labelOf(o)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{o.meta}</span>
      {o.value === shown ? (
        <>
          <Check aria-hidden className="size-4 shrink-0 text-brand" />
          <span className="sr-only">{t("current")}</span>
        </>
      ) : null}
    </CommandItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
          setFound(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-busy={pending || undefined}
          className={`flex h-[38px] min-w-0 max-w-[340px] shrink items-center gap-2.5 rounded-control border border-input bg-card px-3 text-sm font-semibold text-foreground hover:bg-muted ${focus}`}
        >
          <LayoutGrid aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{labelOf(current)}</span>
          <span className="hidden truncate text-[13px] font-medium text-muted-foreground md:inline">{current.trigger}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={t("chooseScope")} className="w-80 p-0">
        <Command shouldFilter={complete}>
          <CommandInput
            placeholder={t("find")}
            aria-label={t("find")}
            {...(complete ? {} : { value: query, onValueChange: setQuery })}
          />
          <CommandList aria-label={t("scopes")}>
            <CommandEmpty>{loading ? t("searching") : t("noMatch")}</CommandEmpty>
            {showAll && <CommandGroup>{item(all!)}</CommandGroup>}
            {clients.length > 0 && <CommandGroup heading={t("clients")}>{clients.map(item)}</CommandGroup>}
            {!complete && found?.more && (
              <button
                type="button"
                onClick={more}
                disabled={paging}
                className={`w-full px-3 py-2 text-left text-sm font-semibold text-brand hover:bg-muted ${focus}`}
              >
                {t("showMore")}
              </button>
            )}
          </CommandList>
        </Command>
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t("followsYou")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
