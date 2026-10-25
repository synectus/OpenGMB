"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { workspaces_create } from "../app/_generated/actions";
import { buttonClass, ErrorText, inputClass } from "./ui";

export function CreateWorkspaceForm() {
  const t = useTranslations("workspaces.form");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    const result = await workspaces_create({ name: String(new FormData(form).get("name")) });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} aria-label={t("label")} className="flex flex-col gap-2">
      <label htmlFor="name" className="text-sm font-semibold text-foreground">
        {t("nameLabel")}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id="name"
          name="name"
          placeholder={t("placeholder")}
          maxLength={100}
          required
          className={`${inputClass} min-w-0 flex-1 sm:max-w-sm`}
        />
        <button type="submit" className={buttonClass} disabled={pending}>
          {t("submit")}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t("unique")}</p>
      <ErrorText message={error} />
    </form>
  );
}
