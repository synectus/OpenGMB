"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { googleConnections_connectSample } from "../app/_generated/actions";
import { buttonClass, ErrorText } from "./ui";

/** Mock mode only: the page renders this when the server reports sampleAvailable. */
export function ConnectSampleGoogleButton() {
  const t = useTranslations("settingsStatus.sampleButton");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    setError(null);
    const result = await googleConnections_connectSample({});
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={onClick} disabled={pending} className={buttonClass}>
        {pending ? t("working") : t("connect")}
      </button>
      <p className="text-sm text-muted-foreground">{t("note")}</p>
      <ErrorText message={error} />
    </div>
  );
}
