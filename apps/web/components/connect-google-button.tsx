"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { googleConnections_connect } from "../app/_generated/actions";
import { buttonClass, ErrorText } from "./ui";

export function ConnectGoogleButton() {
  const t = useTranslations("settingsStatus.connectButton");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    setError(null);
    const result = await googleConnections_connect({});
    if (!result.ok) {
      setPending(false);
      return setError(`${result.error.code}: ${result.error.message}`);
    }
    window.location.assign((result.data as { authUrl: string }).authUrl);
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={onClick} disabled={pending} className={buttonClass}>
        {pending ? t("sending") : t("connect")}
      </button>
      <p className="text-sm text-muted-foreground">
        {pending
          ? t("expires")
          : t("redirect")}
      </p>
      <ErrorText message={error} />
    </div>
  );
}
