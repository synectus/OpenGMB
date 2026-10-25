"use client";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { CategoryMeta } from "../../lib/profile-pickers";
import type { OwnService, ProfileForm, ServiceItem, StructuredDetail } from "../../lib/profile-editor";
import {
  OTHER,
  defaultCurrency,
  filterGroups,
  groupServices,
  highlightParts,
  plainCategory,
  priceText,
  type ServiceRow,
} from "../../lib/services-manager";
import { inputClass } from "../ui";
import { hintClass } from "./section";
import { itemForRow, itemsForGroup, type CopyItem } from "../../lib/copy-services";
import { CopyServicesDialog, type CopyTargets } from "./copy-services-dialog";
import { ServicePanel, type PanelEdit } from "./service-panel";

const small =
  "inline-flex h-9 items-center rounded-control border border-input bg-card px-3 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
/** With this many services or more, only the first category starts open. */
const MANY = 30;

const rowKey = (r: ServiceRow) => (r.kind === "own" ? `own-${r.index}` : `g-${r.id}`);

/**
 * The profile's services, one section per category (primary first, then the others, then "Other").
 * A service opens in a side panel. Every edit goes to the form, so Preview changes shows it.
 */
export function ServicesManager({
  form,
  items,
  categories,
  names,
  regionCode,
  sample,
  loading,
  descriptionMax,
  locationId,
  copyTargets,
  onChange,
}: {
  form: ProfileForm;
  /** Google's structured items as read, for their descriptions and prices. */
  items: ServiceItem[];
  categories: CategoryMeta[];
  names: Record<string, string>;
  regionCode: string;
  sample: boolean;
  loading: boolean;
  descriptionMax: number;
  /** Set when the user may draft descriptions with AI for this location. */
  locationId?: string;
  /** The workspace's other locations; absent when the user cannot edit profiles. */
  copyTargets?: CopyTargets;
  onChange: (patch: Partial<ProfileForm>) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [copy, setCopy] = useState<{ title: string; items: CopyItem[] } | null>(null);
  const t = useTranslations("profile");

  const groups = groupServices({
    own: form.own,
    selected: form.structured,
    items,
    details: form.structuredDetails,
    categories,
    primary: form.primaryCategory,
    additional: form.additionalCategories,
    names,
  });
  const searching = query.trim() !== "";
  const shown = filterGroups(groups, query);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const isClosed = (key: string, i: number) => collapsed[key] ?? (total >= MANY && i > 0);
  const setAll = (closed: boolean) => setCollapsed(Object.fromEntries(groups.map((g) => [g.key, closed])));

  const rows = groups.flatMap((g) => g.rows.map((r) => ({ r, group: g })));
  const current = rows.find((x) => rowKey(x.r) === open);
  const profileCategories = [form.primaryCategory, ...form.additionalCategories]
    .filter(Boolean)
    .map((key) => ({ key, label: names[key] ?? plainCategory(key) }));
  const own = current?.r.kind === "own" ? current.r : null;
  const panelCategories =
    own && !profileCategories.some((c) => c.key === own.category)
      ? [...profileCategories, { key: own.category, label: t("services.notOnProfile", { name: names[own.category] ?? plainCategory(own.category) }) }]
      : profileCategories;
  const prices = [...form.own.map((o) => o.price), ...items.map((s) => s.price)];

  const setOwn = (index: number, patch: Partial<OwnService>) =>
    onChange({ own: form.own.map((o, i) => (i === index ? { ...o, ...patch } : o)) });
  const setDetail = (id: string, patch: StructuredDetail) =>
    onChange({ structuredDetails: { ...form.structuredDetails, [id]: { ...form.structuredDetails[id], ...patch } } });

  function edit(r: ServiceRow, e: PanelEdit) {
    if (r.kind === "own") {
      const { name, description, price, category } = e;
      setOwn(r.index, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(price !== undefined ? { price: price ?? undefined } : {}),
      });
    } else {
      setDetail(r.id, {
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.price !== undefined ? { price: e.price } : {}),
      });
    }
  }

  function remove(r: ServiceRow) {
    setOpen(null);
    if (r.kind === "own") onChange({ own: form.own.filter((_, i) => i !== r.index) });
    else onChange({ structured: form.structured.filter((x) => x !== r.id) });
  }

  function addTo(key: string) {
    onChange({ own: [...form.own, { name: "", description: "", category: key === OTHER ? form.primaryCategory : key }] });
    setCollapsed({ ...collapsed, [key]: false });
    setOpen(`own-${form.own.length}`);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-[1_1_220px]">
          <span className="sr-only">{t("services.search")}</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            className={`${inputClass} w-full pl-9`}
            placeholder={t("services.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className={small} onClick={() => setAll(false)}>
          {t("services.expandAll")}
        </button>
        <button type="button" className={small} onClick={() => setAll(true)}>
          {t("services.collapseAll")}
        </button>
      </div>
      <p role="status" aria-live="polite" className={hintClass}>
        {searching
          ? t("services.matches", { count: shown.matches, query: query.trim() })
          : t("services.total", { services: total, categories: groups.filter((g) => g.count > 0).length })}
        {sample && ` · ${t("services.sample")}`}
        {loading && ` · ${t("services.reading")}`}
      </p>
      {shown.groups.map((g) => {
        const closed = !searching && isClosed(g.key, groups.findIndex((x) => x.key === g.key));
        const label = g.key === OTHER ? t("services.other") : g.label;
        return (
          <section key={g.key} aria-label={t("services.groupLabel", { label })} className="rounded-control border border-border">
            <div className="flex items-center max-sm:flex-wrap">
            <h3 className="m-0 min-w-0 flex-1 text-sm font-bold max-sm:basis-full">
              <button
                type="button"
                aria-expanded={!closed}
                disabled={searching}
                className="flex min-h-11 w-full items-center gap-2 px-3 text-left max-sm:flex-wrap focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                onClick={() => setCollapsed({ ...collapsed, [g.key]: !closed })}
              >
                {!searching && (closed ? <ChevronRight aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />)}
                <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-1.5rem)]">{label}</span>
                <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-muted-foreground">
                  {searching
                    ? t("services.groupMatches", { count: g.rows.length, of: g.of ?? g.rows.length })
                    : t("services.count", { count: g.count })}
                </span>
              </button>
            </h3>
            {copyTargets && !searching && g.key !== OTHER && itemsForGroup(g).length > 0 && (
              <button
                type="button"
                className={`${small} mr-2 shrink-0 max-sm:mx-3 max-sm:mb-2`}
                aria-label={t("services.copyGroupLabel", { label })}
                onClick={() => setCopy({ title: t("services.copyGroupTitle", { label }), items: itemsForGroup(g) })}
              >
                {t.rich("services.copyShort", { extra: (chunks) => <span className="max-sm:hidden">{chunks}</span> })}
              </button>
            )}
            </div>
            {!closed && (
              <div className="flex flex-col gap-1 border-t border-border p-2">
                {g.rows.length === 0 && <p className={hintClass}>{t("services.empty")}</p>}
                <ul className="m-0 flex list-none flex-col p-0">
                  {g.rows.map((r) => (
                    <ServiceListRow
                      key={rowKey(r)}
                      row={r}
                      query={query}
                      onOpen={() => setOpen(rowKey(r))}
                      onToggle={(on) =>
                        onChange({
                          structured:
                            r.kind === "google"
                              ? on
                                ? [...form.structured, r.id]
                                : form.structured.filter((x) => x !== r.id)
                              : form.structured,
                        })
                      }
                    />
                  ))}
                </ul>
                {!searching && g.key !== OTHER && (
                  <div>
                    <button type="button" className={small} onClick={() => addTo(g.key)}>
                      {t("services.addTo", { label })}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
      {searching && shown.matches === 0 && <p className={hintClass}>{t("services.noMatch")}</p>}
      <p className={hintClass}>{t("services.footer")}</p>
      <ServicePanel
        row={current?.r ?? null}
        categories={panelCategories}
        currencyHint={defaultCurrency(prices, regionCode)}
        descriptionMax={descriptionMax}
        draftLocationId={locationId}
        onEdit={(e) => current && edit(current.r, e)}
        onRemove={() => current && remove(current.r)}
        onCopy={
          copyTargets && current && itemForRow(current.r)
            ? () => {
                const one = itemForRow(current.r)!;
                setOpen(null);
                setCopy({ title: t("services.copyOneTitle", { name: one.name }), items: [one] });
              }
            : undefined
        }
        onClose={() => setOpen(null)}
      />
      {copy && copyTargets && (
        <CopyServicesDialog title={copy.title} items={copy.items} targets={copyTargets} onClose={() => setCopy(null)} />
      )}
    </div>
  );
}

/** A piece of text with the part that matches the search marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-warn-bg text-foreground">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/**
 * Every row has the same three parts: a checkbox column (empty for your own services), the name with
 * its price and description, and a trailing slot. A ticked or own service opens the panel (chevron,
 * hover, focus ring). An unticked Google-list service has nothing to edit yet, so its name is the
 * checkbox's label and says so on hover or focus.
 */
function ServiceListRow({
  row,
  query,
  onOpen,
  onToggle,
}: {
  row: ServiceRow;
  query: string;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
}) {
  const id = useId();
  const t = useTranslations("profile");
  const price = priceText(row.price);
  const name = row.name || t("services.newService");
  const main = "group min-h-11 min-w-0 flex-1 rounded-control px-2 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring";
  const unticked = row.kind === "google" && !row.selected;
  return (
    <li className="group/row flex items-center gap-2 py-0.5 pl-1 text-sm">
      {row.kind === "google" ? (
        <input
          id={id}
          type="checkbox"
          className="size-4 shrink-0"
          checked={row.selected}
          aria-label={row.selected ? t("services.include", { name }) : undefined}
          onChange={() => onToggle(!row.selected)}
        />
      ) : (
        <span aria-hidden className="size-4 shrink-0" />
      )}
      {unticked ? (
        <label htmlFor={id} className={`${main} flex cursor-pointer items-center gap-2`}>
          <span className="min-w-0 flex-1 font-medium">
            <Highlight text={name} query={query} />
          </span>
          <span aria-hidden className="hidden shrink-0 text-xs text-muted-foreground group-focus-within/row:inline group-hover/row:inline">
            {t("services.tick")}
          </span>
        </label>
      ) : (
        <button type="button" onClick={onOpen} className={`${main} flex items-center gap-2`}>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">
              <Highlight text={name} query={query} />
            </span>
            {(price || row.description) && (
              <span className="block truncate text-xs text-muted-foreground">
                {price}
                {price && row.description && " · "}
                <Highlight text={row.description} query={query} />
              </span>
            )}
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
        </button>
      )}
    </li>
  );
}
