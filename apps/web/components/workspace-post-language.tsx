"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { workspaces_setPostLanguage } from "../app/_generated/actions";
import { filterFieldClass } from "./page-parts";
import { ErrorText } from "./ui";

/** The language new posts in this workspace start in. Saves on change. */
export function WorkspacePostLanguage({
  workspaceId,
  workspaceName,
  value,
  languages,
}: {
  workspaceId: string;
  workspaceName: string;
  value: string;
  languages: readonly { code: string; label: string }[];
}) {
  const t = useTranslations("settings.postLanguage");
  const router = useRouter();
  const [current, setCurrent] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(language: string) {
    const before = current;
    setCurrent(language);
    setBusy(true);
    setError(null);
    const r = await workspaces_setPostLanguage({ workspaceId, language });
    if (!r.ok) {
      setCurrent(before);
      setError(`${r.error.code}: ${r.error.message}`);
    } else router.refresh();
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={t("label", { name: workspaceName })}
        className={filterFieldClass}
        value={current}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      >
        {languages.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      <ErrorText message={error} />
    </div>
  );
}
