"use client";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ai_draftServiceDescription } from "../../app/_generated/actions";
import { AiDraftButton } from "./ai-draft";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../primitives/dialog";
import {
  amountToMoney,
  currencyOptions,
  moneyToAmount,
  supportedCurrencies,
  type Money,
  type ServiceRow,
} from "../../lib/services-manager";
import { buttonClass, destructiveButtonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";
import { fieldLabelClass, usePhrase } from "./section";

export type PanelEdit = {
  name?: string;
  description?: string;
  /** null removes the price. */
  price?: Money | null;
  category?: string;
};

/**
 * Edits one service. Every change goes straight to the form, so the "Preview changes" bar shows it
 * as a Services change; nothing is saved here. A Google-list service has a fixed name and category.
 */
export function ServicePanel({
  row,
  categories,
  currencyHint,
  descriptionMax,
  draftLocationId,
  onEdit,
  onRemove,
  onCopy,
  onClose,
}: {
  row: ServiceRow | null;
  categories: { key: string; label: string }[];
  currencyHint: string;
  descriptionMax: number;
  /** Set when the user may draft the description with AI for this location. */
  draftLocationId?: string;
  onEdit: (edit: PanelEdit) => void;
  onRemove: () => void;
  /** Set when the service can be copied to other locations. */
  onCopy?: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="inset-y-0 top-0 right-0 left-auto h-dvh w-full max-w-none translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:max-w-md"
      >
        {row && (
          <PanelBody
            key={row.kind === "own" ? `own-${row.index}` : row.id}
            row={row}
            categories={categories}
            currencyHint={currencyHint}
            descriptionMax={descriptionMax}
            draftLocationId={draftLocationId}
            onEdit={onEdit}
            onRemove={onRemove}
            onCopy={onCopy}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PanelBody({
  row,
  categories,
  currencyHint,
  descriptionMax,
  draftLocationId,
  onEdit,
  onRemove,
  onCopy,
  onClose,
}: {
  row: ServiceRow;
  categories: { key: string; label: string }[];
  currencyHint: string;
  descriptionMax: number;
  draftLocationId?: string;
  onEdit: (edit: PanelEdit) => void;
  onRemove: () => void;
  onCopy?: () => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(moneyToAmount(row.price));
  const [currency, setCurrency] = useState(row.price?.currencyCode ?? currencyHint);
  const currencies = useMemo(() => currencyOptions(supportedCurrencies(), currency), [currency]);
  const [priceError, setPriceError] = useState<string | null>(null);
  const t = useTranslations("profile");
  const phrase = usePhrase();
  const own = row.kind === "own";
  const chars = Array.from(row.description).length;
  const categoryLabel = row.kind === "own" ? categories.find((c) => c.key === row.category)?.label : undefined;

  function setPrice(nextAmount: string, nextCurrency: string) {
    setAmount(nextAmount);
    setCurrency(nextCurrency);
    const r = amountToMoney(nextAmount, nextCurrency);
    if ("error" in r) return setPriceError(phrase(r.error));
    setPriceError(null);
    onEdit({ price: r.money });
  }

  return (
    <>
      <DialogHeader className="pr-8 text-left">
        <DialogTitle>{row.name || t("services.newService")}</DialogTitle>
        <DialogDescription>
          {own ? t("services.panel.ownNote") : t("services.panel.googleNote")}
        </DialogDescription>
      </DialogHeader>
      {own && (
        <label className={fieldLabelClass}>
          {t("services.panel.name")}
          <input
            className={inputClass}
            maxLength={500}
            value={row.name}
            onChange={(e) => onEdit({ name: e.target.value })}
          />
        </label>
      )}
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClass}>
          {t("sections.Description")}
          <textarea
            className={`${inputClass} min-h-28`}
            rows={5}
            value={row.description}
            onChange={(e) => onEdit({ description: e.target.value })}
          />
        </label>
        {draftLocationId && row.name.trim() !== "" && (
          <AiDraftButton
            hasText={row.description.trim() !== ""}
            onFill={(description) => onEdit({ description })}
            call={() =>
              ai_draftServiceDescription({
                locationId: draftLocationId,
                serviceName: row.name.trim(),
                ...(categoryLabel ? { categoryName: categoryLabel } : {}),
                ...(row.description.trim() ? { currentDescription: row.description.trim() } : {}),
              })
            }
          />
        )}
        <span className={`text-xs ${chars > descriptionMax ? "font-semibold text-bad" : "text-muted-foreground"}`}>
          {t("services.panel.chars", { chars, max: String(descriptionMax) })}
        </span>
      </div>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">{t("services.panel.price")}</legend>
        <div className="flex gap-2">
          <label className={`${fieldLabelClass} flex-[1_1_120px]`}>
            {t("services.panel.amount")}
            <input
              className={inputClass}
              inputMode="decimal"
              placeholder={t("services.panel.noPrice")}
              value={amount}
              onChange={(e) => setPrice(e.target.value, currency)}
            />
          </label>
          <label className={`${fieldLabelClass} w-24`}>
            {t("services.panel.currency")}
            <select className={inputClass} value={currency} onChange={(e) => setPrice(amount, e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ErrorText message={priceError} />
      </fieldset>
      {own && (
        <label className={fieldLabelClass}>
          {t("services.panel.category")}
          <select className={inputClass} value={row.category} onChange={(e) => onEdit({ category: e.target.value })}>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <DialogFooter className="sm:justify-between">
        <button type="button" className={destructiveButtonClass} onClick={onRemove}>
          {own ? t("services.panel.removeService") : t("services.panel.removeFromProfile")}
        </button>
        {onCopy && (
          <button type="button" className={secondaryButtonClass} onClick={onCopy}>
            {t("services.copyToLocations")}
          </button>
        )}
        <button type="button" className={buttonClass} onClick={onClose}>
          {t("done")}
        </button>
      </DialogFooter>
    </>
  );
}
