"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { foodMenusGet } from "@opengmb/core";
import { foodMenus_get, foodMenus_update } from "../app/_generated/actions";
import { runCall } from "./post-card";
import {
  currencyOf,
  foodMenuFailure,
  foodMenuOpText,
  menuProblem,
  nameOf,
  newItem,
  newMenu,
  newSection,
  parsePrice,
  priceText,
  removeAt,
  replaceAt,
  withDescription,
  withName,
  type Menu,
} from "../lib/food-menu";
import { ItemFields } from "./food-menu-item-fields";
import { h2Class, sectionClass } from "./profile/section";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "./ui";

type Listed = Awaited<ReturnType<(typeof foodMenusGet)["handler"]>>;
export type FoodMenuOp = Listed["operations"][number];

const POLL_MS = 1500;
const POLL_TRIES = 40;

async function settle(locationId: string, opId: string): Promise<string | null> {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    const r = await runCall<Listed>(() => foodMenus_get({ locationId }));
    if ("error" in r) return r.error;
    const op = r.data.operations.find((o) => o.id === opId);
    if (op && op.status === "failed") return foodMenuFailure(op.error);
    if (op && op.status !== "pending") return null;
  }
  return "Still working in the background; refresh in a moment.";
}

/** Food menu (restaurants): sections and items with prices. Saving queues one write for the whole menu. */
export function FoodMenuEditor({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const router = useRouter();
  // Nothing is fetched until the person asks: most locations are not restaurants, and each read is a Google call.
  const [phase, setPhase] = useState<"closed" | "loading" | "ready" | "unsupported">("closed");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operations, setOperations] = useState<FoodMenuOp[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  // Price boxes hold what was typed; the menu itself only changes once the text is a valid price.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const currency = currencyOf(menus);
  const pending = operations.some((o) => o.status === "pending");
  const edit = (next: Menu[]) => {
    setMenus(next);
    setSaved(false);
  };
  const setMenu = (mi: number, m: Menu) => edit(replaceAt(menus, mi, m));

  async function load() {
    setPhase("loading");
    setLoadError(null);
    const r = await runCall<Listed>(() => foodMenus_get({ locationId }));
    if ("error" in r) {
      setLoadError(r.error);
      return setPhase("closed");
    }
    setOperations(r.data.operations);
    setMenus(r.data.menus as unknown as Menu[]);
    setPhase(r.data.supported ? "ready" : "unsupported");
  }

  async function save() {
    const bad = menuProblem(menus);
    if (bad) return setError(bad);
    setBusy(true);
    setError(null);
    const r = await runCall<{ operation: FoodMenuOp }>(() => foodMenus_update({ locationId, menus }) as never);
    if ("error" in r) {
      setBusy(false);
      return setError(r.error);
    }
    const problem = await settle(locationId, r.data.operation.id);
    setBusy(false);
    if (problem) setError(problem);
    else setSaved(true);
    const again = await runCall<Listed>(() => foodMenus_get({ locationId }));
    if (!("error" in again)) setOperations(again.data.operations);
    router.refresh();
  }

  return (
    <section aria-labelledby="food-menu" className={sectionClass}>
      <h2 id="food-menu" className={h2Class}>Food menu</h2>
      <p className="text-sm text-muted-foreground">
        For restaurants and cafes. Saving replaces the whole menu on Google, so check it before you save.
      </p>
      {phase === "closed" && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={secondaryButtonClass} onClick={load}>Load food menu</button>
          <span className="text-xs text-muted-foreground">Reads the menu from Google.</span>
        </div>
      )}
      {phase === "loading" && <p role="status" className="text-sm text-muted-foreground">Loading the food menu...</p>}
      <ErrorText message={loadError} />
      {phase === "unsupported" && (
        <p role="status" className="text-sm text-muted-foreground">This location can&apos;t have a food menu on Google.</p>
      )}
      {phase === "ready" && menus.length === 0 && <p className="text-sm text-muted-foreground">No menu yet.</p>}
      {phase === "ready" && menus.map((menu, mi) => (
        <div key={mi} className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Menu name
            <input className={inputClass} disabled={!canEdit} value={nameOf(menu)} maxLength={140}
              onChange={(e) => setMenu(mi, withName(menu, e.target.value))} />
          </label>
          {menu.sections.map((section, si) => (
            <fieldset key={si} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Section {si + 1}</legend>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-[1_1_200px] flex-col gap-1 text-sm font-medium">
                  Section name
                  <input className={inputClass} disabled={!canEdit} value={nameOf(section)} maxLength={140}
                    onChange={(e) => setMenu(mi, { ...menu, sections: replaceAt(menu.sections, si, withName(section, e.target.value)) })} />
                </label>
                {canEdit && (
                  <button type="button" className={secondaryButtonClass}
                    onClick={() => setMenu(mi, { ...menu, sections: removeAt(menu.sections, si) })}>
                    Remove section
                  </button>
                )}
              </div>
              {section.items.map((item, ii) => {
                const key = `${mi}.${si}.${ii}`;
                const setItem = (next: typeof item) =>
                  setMenu(mi, { ...menu, sections: replaceAt(menu.sections, si, { ...section, items: replaceAt(section.items, ii, next) }) });
                const shown = typed[key] ?? priceText(item.attributes.price);
                const invalid = shown !== "" && !parsePrice(shown, item.attributes.price.currencyCode);
                return (
                  <div key={ii} className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex min-w-0 flex-[2_1_160px] flex-col gap-1 text-sm font-medium">
                        Item name
                        <input className={inputClass} disabled={!canEdit} value={nameOf(item)} maxLength={140}
                          onChange={(e) => setItem(withName(item, e.target.value))} />
                      </label>
                      <label className="flex w-28 flex-col gap-1 text-sm font-medium">
                        Price ({item.attributes.price.currencyCode})
                        <input className={inputClass} disabled={!canEdit} inputMode="decimal" value={shown}
                          aria-invalid={invalid}
                          onChange={(e) => {
                            const text = e.target.value;
                            setTyped({ ...typed, [key]: text });
                            const price = parsePrice(text, item.attributes.price.currencyCode);
                            if (price) setItem({ ...item, attributes: { ...item.attributes, price } });
                          }} />
                      </label>
                      {canEdit && (
                        <button type="button" className={secondaryButtonClass}
                          onClick={() => setMenu(mi, { ...menu, sections: replaceAt(menu.sections, si, { ...section, items: removeAt(section.items, ii) }) })}>
                          Remove item
                        </button>
                      )}
                    </div>
                    <label className="flex flex-col gap-1 text-sm font-medium">
                      Description (optional)
                      <textarea className={inputClass} disabled={!canEdit} rows={2} maxLength={1000}
                        value={item.labels[0]?.description ?? ""}
                        onChange={(e) => setItem(withDescription(item, e.target.value))} />
                    </label>
                    {invalid && <p role="alert" className="text-xs text-bad">Use a price like 12 or 12.50.</p>}
                    <ItemFields item={item} currency={item.attributes.price.currencyCode} canEdit={canEdit} onChange={setItem} />
                  </div>
                );
              })}
              {canEdit && (
                <button type="button" className={secondaryButtonClass}
                  onClick={() => setMenu(mi, { ...menu, sections: replaceAt(menu.sections, si, { ...section, items: [...section.items, newItem(currency)] }) })}>
                  Add item
                </button>
              )}
            </fieldset>
          ))}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButtonClass}
                onClick={() => setMenu(mi, { ...menu, sections: [...menu.sections, newSection(currency)] })}>
                Add section
              </button>
              <button type="button" className={secondaryButtonClass}
                onClick={() => {
                  if (window.confirm("Remove this whole menu? It is removed from Google when you save."))
                    edit(removeAt(menus, mi));
                }}>
                Remove menu
              </button>
            </div>
          )}
        </div>
      ))}
      {phase === "ready" && pending && (
        <p role="status" className="rounded-lg bg-info-bg px-3 py-2 text-sm font-semibold text-info">{foodMenuOpText}</p>
      )}
      <ErrorText message={error} />
      {phase === "ready" && saved && <p role="status" className="text-sm font-semibold text-good">Saved to Google.</p>}
      {phase === "ready" && canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => edit([...menus, newMenu(currency)])}>
            Add menu
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={save}>
            {busy ? "Working..." : "Save menu"}
          </button>
        </div>
      )}
    </section>
  );
}
