"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { attributeLabel } from "@/lib/labels";
import {
  attributeGroups,
  attributeSummary,
  boolChoice,
  boolValue,
  changedAttributes,
  enumOf,
  enumValue,
  repeatedOf,
  repeatedValue,
  socialAttributes,
  uriOf,
  uriValue,
  type AttributeMeta,
  type BoolChoice,
} from "../../lib/profile-pickers";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../primitives/dialog";
import { ErrorText, buttonClass, inputClass, secondaryButtonClass } from "../ui";
import { EditorSection, fieldLabelClass, hintClass } from "./section";

type Values = Record<string, unknown>;
const CHOICES: BoolChoice[] = ["yes", "no", "unset"];

function AttributeControl({
  meta,
  value,
  before,
  onChange,
}: {
  meta: AttributeMeta;
  value: unknown;
  before: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useTranslations("profile");
  if (meta.valueType === "BOOL") {
    const c = boolChoice(value);
    return (
      <div
        role="radiogroup"
        aria-label={meta.displayName}
        className="inline-flex overflow-hidden rounded-control border border-input"
      >
        {CHOICES.map((o, i) => (
          <label
            key={o}
            className={`flex cursor-pointer items-center px-3 py-1.5 text-sm ${i ? "border-l border-input" : ""} ${c === o ? "bg-brand-tint font-bold" : "bg-card"}`}
          >
            <input
              type="radio"
              className="sr-only"
              name={`attr-${meta.name}`}
              checked={c === o}
              onChange={() => onChange(boolValue(o))}
            />
            {t(`attributes.choice.${o}`)}
          </label>
        ))}
      </div>
    );
  }
  if (meta.valueType === "ENUM") {
    return (
      <select
        aria-label={meta.displayName}
        className={inputClass}
        value={enumOf(value)}
        onChange={(e) => onChange(enumValue(e.target.value))}
      >
        <option value="">{t("attributes.choice.unset")}</option>
        {meta.values.map((v) => (
          <option key={String(v.value)} value={String(v.value)}>
            {v.displayName}
          </option>
        ))}
      </select>
    );
  }
  if (meta.valueType === "REPEATED_ENUM") {
    const set = repeatedOf(value);
    return (
      <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
        <legend className="sr-only">{meta.displayName}</legend>
        {meta.values.map((v) => {
          const id = String(v.value);
          return (
            <label key={id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={set.includes(id)}
                onChange={(e) =>
                  onChange(
                    repeatedValue(
                      e.target.checked ? [...set, id] : set.filter((x) => x !== id),
                      repeatedOf(before),
                    ),
                  )
                }
              />
              {v.displayName}
            </label>
          );
        })}
      </fieldset>
    );
  }
  return (
    <input
      type="url"
      aria-label={meta.displayName}
      className={inputClass}
      placeholder="https://"
      value={uriOf(value)}
      onChange={(e) => onChange(uriValue(e.target.value))}
    />
  );
}

export function AttributesSection({
  metas,
  values,
  original,
  loading,
  error,
  onChange,
}: {
  metas: AttributeMeta[];
  values: Values;
  original: Values;
  loading: boolean;
  error: string | null;
  onChange: (v: Values) => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const t = useTranslations("profile");
  const groups = attributeGroups(metas, query);
  const current = groups.find((g) => g.group === group) ?? groups[0];
  const changes = Object.keys(changedAttributes(original, values)).length;
  const set = Object.entries(values).filter(([, v]) => v !== null);
  const byName = new Map(metas.map((m) => [m.name, m]));
  const social = new Set(socialAttributes(metas).map((m) => m.name));
  // attributeSummary is the lib's English "Label: value"; only its own Not set / Yes / No words are translated.
  const summary = (meta: AttributeMeta | undefined, v: unknown, n: string) =>
    attributeSummary(meta, v, n).replace(/: (Not set|Yes|No)$/, (_, w: string) =>
      `: ${t(`attributes.choice.${w === "Not set" ? "unset" : w.toLowerCase()}`)}`,
    );
  return (
    <EditorSection label="Attributes">
      {loading && (
        <p role="status" className={hintClass}>
          {t("attributes.reading")}
        </p>
      )}
      <ErrorText message={error} />
      <ul className="flex flex-col gap-1 text-sm">
        {set
          .filter(([n]) => !social.has(n))
          .map(([n, v]) => (
            <li key={n} className="flex flex-wrap items-baseline gap-2">
              <span>{summary(byName.get(n), v, n)}</span>
            </li>
          ))}
        {set.length === 0 && <li className="text-muted-foreground">{t("attributes.none")}</li>}
      </ul>
      <Dialog>
        <DialogTrigger asChild>
          <button type="button" className={secondaryButtonClass} disabled={metas.length === 0}>
            {t("attributes.edit")}
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("sections.Attributes")}</DialogTitle>
          </DialogHeader>
          <input
            aria-label={t("attributes.search")}
            placeholder={t("attributes.search")}
            className={inputClass}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex min-h-64 flex-wrap gap-4">
            <nav aria-label={t("attributes.groups")} className="flex min-w-40 flex-col">
              {groups.map((g) => (
                <button
                  key={g.group}
                  type="button"
                  aria-current={g === current ? "true" : undefined}
                  onClick={() => setGroup(g.group)}
                  className={`px-3 py-2 text-left text-sm ${g === current ? "bg-brand-tint font-bold text-brand-text shadow-[inset_3px_0_0_var(--color-brand)]" : "font-medium"}`}
                >
                  {g.group}
                </button>
              ))}
            </nav>
            <ul aria-label={t("sections.Attributes")} className="flex min-w-0 flex-1 flex-col gap-3">
              {(current?.items ?? []).map((m) => (
                <li
                  key={m.name}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2"
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-semibold">{m.displayName}</span>
                  </span>
                  <AttributeControl
                    meta={m}
                    value={values[m.name] ?? null}
                    before={original[m.name] ?? null}
                    onChange={(v) => onChange({ ...values, [m.name]: v })}
                  />
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter className="items-center">
            <span className={hintClass}>
              {t("attributes.changes", { count: changes })}
            </span>
            <DialogClose asChild>
              <button type="button" className={buttonClass}>
                {t("done")}
              </button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p className={hintClass}>{t("attributes.onlyChanged")}</p>
    </EditorSection>
  );
}

/** Rendered only for the social ids Google offers for this category (see Facts: an assumption checked at runtime). */
export function SocialProfiles({
  metas,
  values,
  onChange,
}: {
  metas: AttributeMeta[];
  values: Values;
  onChange: (v: Values) => void;
}) {
  const t = useTranslations("profile");
  const offered = socialAttributes(metas);
  if (offered.length === 0) return null;
  return (
    <EditorSection label="Social profiles">
      {offered.map((m) => (
        <label key={m.name} className={fieldLabelClass}>
          {m.displayName}
          <input
            type="url"
            className={inputClass}
            placeholder={`https://${m.displayName.toLowerCase()}.com/…`}
            value={uriOf(values[m.name])}
            onChange={(e) => onChange({ ...values, [m.name]: uriValue(e.target.value) })}
          />
        </label>
      ))}
      <p className={hintClass}>
        {t("attributes.socialSaved", { list: offered.map((m) => attributeLabel(m.name, offered)).join(", ") })}
      </p>
    </EditorSection>
  );
}
