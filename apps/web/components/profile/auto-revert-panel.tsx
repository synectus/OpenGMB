"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { profile_autoRevert_set } from "../../app/_generated/actions";
import { runCall } from "../post-card";
import { ErrorText } from "../ui";
import { h2Class, hintClass, sectionClass } from "./section";

type Flags = { name: boolean; phone: boolean; address: boolean };
const KEYS = ["name", "phone", "address"] as const;

/** L8: per-location switches for undoing outside edits to the name, phone and address. Owner/admin only. */
export function AutoRevertPanel({
  locationId,
  initial,
  canConfigure,
}: {
  locationId: string;
  initial: Flags;
  canConfigure: boolean;
}) {
  const t = useTranslations("profile.autoRevert");
  const [flags, setFlags] = useState<Flags>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function change(key: (typeof KEYS)[number], on: boolean) {
    const prev = flags;
    setFlags({ ...flags, [key]: on });
    setState("saving");
    setError(null);
    const r = await runCall<Flags>(() => profile_autoRevert_set({ locationId, [key]: on }));
    if ("error" in r) {
      setFlags(prev);
      setError(r.error);
      setState("idle");
      return;
    }
    setFlags({ name: r.data.name, phone: r.data.phone, address: r.data.address });
    setState("saved");
  }

  return (
    <section aria-label={t("title")} className={sectionClass}>
      <h2 className={h2Class}>{t("title")}</h2>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm">{t("intro")}</legend>
        {KEYS.map((k) => (
          <label key={k} className="flex min-h-9 items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={flags[k]}
              disabled={!canConfigure || state === "saving"}
              onChange={(e) => change(k, e.target.checked)}
            />
            {t(k)}
          </label>
        ))}
      </fieldset>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {state === "saving" ? t("saving") : state === "saved" ? t("saved") : ""}
      </p>
      <ErrorText message={error} />
      {!canConfigure && <p className={hintClass}>{t("askOwner")}</p>}
      <p className={hintClass}>{t("note")}</p>
    </section>
  );
}
