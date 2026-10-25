"use client";
import { useState } from "react";
import {
  ALLERGENS,
  DIETARY,
  SPICINESS,
  newOption,
  nameOf,
  parsePrice,
  priceText,
  removeAt,
  replaceAt,
  spicinessOf,
  toggleValue,
  withName,
  withSpiciness,
  type ItemOption,
  type Menu,
} from "../lib/food-menu";
import { inputClass, secondaryButtonClass } from "./ui";

type Item = Menu["sections"][number]["items"][number];

function Tags({ legend, list, chosen, canEdit, onToggle }: {
  legend: string;
  list: readonly (readonly [string, string])[];
  chosen: string[];
  canEdit: boolean;
  onToggle: (value: string, on: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {list.map(([value, label]) => (
          <label key={value} className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={chosen.includes(value)}
              onChange={(e) => onToggle(value, e.target.checked)} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function OptionRow({ option, canEdit, onChange, onRemove }: {
  option: ItemOption;
  canEdit: boolean;
  onChange: (next: ItemOption) => void;
  onRemove: () => void;
}) {
  // The box holds what was typed; the option only changes once the text is a valid price.
  const [typed, setTyped] = useState<string | null>(null);
  const currency = option.attributes.price.currencyCode;
  // Typed text is only trusted while it still describes this option's price (rows shift when one is removed).
  const parsed = typed === null ? null : parsePrice(typed, currency);
  const stale = typed !== null && parsed !== null && priceText(parsed) !== priceText(option.attributes.price);
  const shown = typed === null || stale ? priceText(option.attributes.price) : typed;
  const invalid = shown !== "" && !parsePrice(shown, currency);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-[2_1_140px] flex-col gap-1 text-sm font-medium">
        Option name
        <input className={inputClass} disabled={!canEdit} value={nameOf(option)} maxLength={140}
          onChange={(e) => onChange(withName(option, e.target.value))} />
      </label>
      <label className="flex w-28 flex-col gap-1 text-sm font-medium">
        Price ({currency})
        <input className={inputClass} disabled={!canEdit} inputMode="decimal" value={shown} aria-invalid={invalid}
          onChange={(e) => {
            setTyped(e.target.value);
            const price = parsePrice(e.target.value, currency);
            if (price) onChange({ ...option, attributes: { ...option.attributes, price } });
          }} />
      </label>
      {canEdit && (
        <button type="button" className={secondaryButtonClass} onClick={onRemove}>Remove option</button>
      )}
      {invalid && <p role="alert" className="w-full text-xs text-bad">Use a price like 12 or 12.50.</p>}
    </div>
  );
}

/** Allergens, dietary tags, spiciness and options (for example sizes) of one menu item. */
export function ItemFields({ item, currency, canEdit, onChange }: {
  item: Item;
  currency: string;
  canEdit: boolean;
  onChange: (next: Item) => void;
}) {
  const attrs = item.attributes;
  const options = item.options ?? [];
  const setOptions = (next: ItemOption[]) => {
    const rest = { ...item };
    delete rest.options;
    onChange(next.length > 0 ? { ...rest, options: next } : rest);
  };
  return (
    <div className="flex flex-col gap-2">
      <Tags legend="Allergens" list={ALLERGENS} chosen={attrs.allergen ?? []} canEdit={canEdit}
        onToggle={(v, on) => onChange({ ...item, attributes: toggleValue(attrs, "allergen", v, on) })} />
      <Tags legend="Dietary" list={DIETARY} chosen={attrs.dietaryRestriction ?? []} canEdit={canEdit}
        onToggle={(v, on) => onChange({ ...item, attributes: toggleValue(attrs, "dietaryRestriction", v, on) })} />
      <label className="flex flex-col gap-1 text-sm font-medium sm:max-w-48">
        Spiciness
        <select className={inputClass} disabled={!canEdit} value={spicinessOf(attrs)}
          onChange={(e) => onChange({ ...item, attributes: withSpiciness(attrs, e.target.value) })}>
          <option value="">Not set</option>
          {SPICINESS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {(options.length > 0 || canEdit) && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Options (for example sizes)</legend>
          {options.map((option, oi) => (
            <OptionRow key={oi} option={option} canEdit={canEdit}
              onChange={(next) => setOptions(replaceAt(options, oi, next))}
              onRemove={() => setOptions(removeAt(options, oi))} />
          ))}
          {canEdit && (
            <button type="button" className={`${secondaryButtonClass} self-start`}
              onClick={() => setOptions([...options, newOption(currency)])}>
              Add option
            </button>
          )}
        </fieldset>
      )}
    </div>
  );
}
