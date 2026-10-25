"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiTokens_revoke } from "../app/_generated/actions";
import { ErrorText } from "./ui";

export function RevokeTokenButton({ id }: { id: string }) {
  const t = useTranslations("settingsTeam.revokeToken");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (!window.confirm(t("confirm"))) return;
    setPending(true);
    setError(null);
    const result = await apiTokens_revoke({ id });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-8 items-center rounded-control border border-bad-border bg-card px-3 text-[13px] font-semibold text-bad hover:bg-bad-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
      >
        {t("revoke")}
      </button>
      <ErrorText message={error} />
    </>
  );
}
