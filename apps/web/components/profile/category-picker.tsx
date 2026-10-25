"use client";
import { ChevronDown, X } from "lucide-react";
import { categoryLabel } from "@/lib/labels";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { profile_categories_search } from "../../app/_generated/actions";
import {
  addAdditional,
  categoryTag,
  choosePrimary,
} from "../../lib/profile-pickers";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover";
import { runCall } from "../post-card";
import { ErrorText, inputClass, secondaryButtonClass } from "../ui";
import { hintClass } from "./section";

const SEARCH_DEBOUNCE_MS = 300;
const sampleBadge =
  "inline-flex h-[22px] items-center rounded-full bg-secondary px-2.5 text-xs font-bold text-secondary-foreground";
type Option = { name: string; displayName: string };

function SearchList({
  locationId,
  regionCode,
  languageCode,
  minChars,
  primary,
  additional,
  onPick,
}: {
  locationId: string;
  regionCode: string;
  languageCode: string;
  minChars: number;
  primary: string;
  additional: string[];
  onPick: (o: Option) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [source, setSource] = useState<"google" | "sample" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("profile");
  const locale = useLocale();
  const region = new Intl.DisplayNames([locale], { type: "region" }).of(regionCode) ?? regionCode;
  const base = languageCode.split("-")[0] ?? languageCode;
  const language = new Intl.DisplayNames([locale], { type: "language" }).of(base) ?? languageCode;
  useEffect(() => {
    const q = query.trim();
    let stop = false;
    const timer = setTimeout(async () => {
      if (Array.from(q).length < minChars) return setOptions([]);
      const r = await runCall<{ categories: Option[]; source: "google" | "sample" }>(() =>
        profile_categories_search({ locationId, regionCode, languageCode, query: q }),
      );
      if (stop) return;
      if ("error" in r) return setError(r.error);
      setError(null);
      setOptions(r.data.categories);
      setSource(r.data.source);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [query, locationId, regionCode, languageCode, minChars]);
  return (
    <div className="flex flex-col gap-2">
      <input
        aria-label={t("categories.search")}
        placeholder={t("categories.search")}
        autoFocus
        className={inputClass}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ErrorText message={error} />
      <ul aria-label={t("sections.Categories")} className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {options.map((o) => {
          const tag = categoryTag(o.name, primary, additional);
          return (
            <li key={o.name}>
              <button
                type="button"
                onClick={() => onPick(o)}
                className={`flex w-full items-center gap-2 rounded-control border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${tag === "Primary" ? "border-brand bg-brand-tint font-bold" : "border-transparent font-medium"}`}
              >
                <span className="flex-1">{o.displayName}</span>
                {tag && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${tag === "Primary" ? "bg-good-bg text-good" : "bg-secondary text-secondary-foreground"}`}
                  >
                    {t(`categories.tag.${tag}`)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <span className={hintClass}>{t("categories.localeLine", { region, language })}</span>
        {source === "sample" && <span className={sampleBadge}>{t("categories.sample")}</span>}
      </div>
    </div>
  );
}

export function CategoryPicker({
  locationId,
  regionCode,
  languageCode,
  minChars,
  primary,
  additional,
  names,
  onChange,
}: {
  locationId: string;
  regionCode: string;
  languageCode: string;
  minChars: number;
  primary: string;
  additional: string[];
  names: Record<string, string>;
  onChange: (primary: string, additional: string[]) => void;
}) {
  const [open, setOpen] = useState<"primary" | "add" | null>(null);
  const [known, setKnown] = useState<Record<string, string>>({});
  const t = useTranslations("profile");
  const name = (id: string) => categoryLabel(id, { ...names, ...known });
  const remember = (o: Option) => setKnown((k) => ({ ...k, [o.name]: o.displayName }));
  const list = (mode: "primary" | "add") => (
    <PopoverContent align="start" className="w-[min(92vw,480px)]">
      <SearchList
        locationId={locationId}
        regionCode={regionCode}
        languageCode={languageCode}
        minChars={minChars}
        primary={primary}
        additional={additional}
        onPick={(o) => {
          remember(o);
          if (mode === "primary") {
            const r = choosePrimary(additional, o.name);
            onChange(r.primary, r.additional);
          } else onChange(primary, addAdditional(primary, additional, o.name));
          setOpen(null);
        }}
      />
    </PopoverContent>
  );
  return (
    <>
      <div className="flex flex-col gap-1">
        <span id="primary-cat-label" className="text-sm font-medium">
          {t("categories.primary")}
        </span>
        <Popover open={open === "primary"} onOpenChange={(o) => setOpen(o ? "primary" : null)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-labelledby="primary-cat-label"
              className={`${inputClass} flex items-center gap-2 text-left`}
            >
              <span className="flex-1 font-semibold">
                {primary ? name(primary) : t("categories.choose")}
              </span>
              <ChevronDown aria-hidden className="size-4" />
            </button>
          </PopoverTrigger>
          {list("primary")}
        </Popover>
      </div>
      <div className="flex flex-col gap-2">
        <span id="more-cats" className="text-sm font-medium">
          {t("categories.additional")}
        </span>
        <ul aria-labelledby="more-cats" className="flex flex-wrap gap-2">
          {additional.map((id) => (
            <li
              key={id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary py-0.5 pl-3 pr-1 text-sm"
            >
              {name(id)}
              <button
                type="button"
                aria-label={t("removeItem", { name: name(id) })}
                className="rounded-full p-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() =>
                  onChange(
                    primary,
                    additional.filter((x) => x !== id),
                  )
                }
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
          <li>
            <Popover open={open === "add"} onOpenChange={(o) => setOpen(o ? "add" : null)}>
              <PopoverTrigger asChild>
                <button type="button" className={secondaryButtonClass}>
                  {t("categories.add")}
                </button>
              </PopoverTrigger>
              {list("add")}
            </Popover>
          </li>
        </ul>
      </div>
      <p className={hintClass}>{t("categories.hint")}</p>
    </>
  );
}

type BulkPickerProps = {
  /** Any location of the edit: it only picks the Google connection and checks scope. */
  locationId: string;
  regionCode: string;
  languageCode: string;
  minChars: number;
  /** Display names already known (id to name), shared across the pickers of one form. */
  names: Record<string, string>;
  onLearn: (o: Option) => void;
  /** The picker was opened and closed, or changed: the field counts as touched. */
  onTouch: () => void;
  label: string;
  describedBy?: string;
};

/** Bulk edit: several categories to add to each location's own list. No primary: the primary is never touched. */
export function AddCategoriesPicker({
  chosen,
  onChange,
  label,
  describedBy,
  names,
  onLearn,
  onTouch,
  ...search
}: BulkPickerProps & { chosen: string[]; onChange: (ids: string[]) => void }) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const t = useTranslations("profile");
  const name = (id: string) => categoryLabel(id, names);
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {chosen.map((id) => (
          <li
            key={id}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary py-0.5 pl-3 pr-1 text-sm"
          >
            {name(id)}
            <button
              type="button"
              aria-label={t("removeItem", { name: name(id) })}
              className="rounded-full p-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                onChange(chosen.filter((x) => x !== id));
                onTouch();
              }}
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </li>
        ))}
        <li>
          <Popover
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              if (!o) onTouch();
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-describedby={describedBy}
                className={secondaryButtonClass}
              >
                {t("categories.add")}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(92vw,480px)]">
              <SearchList
                {...search}
                primary=""
                additional={chosen}
                onPick={(o) => {
                  onLearn(o);
                  if (!chosen.includes(o.name)) onChange([...chosen, o.name]);
                  setOpen(false);
                  onTouch();
                }}
              />
            </PopoverContent>
          </Popover>
        </li>
      </ul>
    </div>
  );
}

/** Bulk edit: one category (the category the new services go in). */
export function SingleCategoryPicker({
  value,
  onChange,
  label,
  describedBy,
  names,
  onLearn,
  onTouch,
  ...search
}: BulkPickerProps & { value: string; onChange: (id: string) => void }) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const t = useTranslations("profile");
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) onTouch();
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            className={`${inputClass} flex items-center gap-2 text-left`}
          >
            <span className="flex-1 font-semibold">{value ? categoryLabel(value, names) : t("categories.choose")}</span>
            <ChevronDown aria-hidden className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(92vw,480px)]">
          <SearchList
            {...search}
            primary={value}
            additional={[]}
            onPick={(o) => {
              onLearn(o);
              onChange(o.name);
              setOpen(false);
              onTouch();
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
