"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { googleConnections_disconnect } from "../app/_generated/actions";
import { destructiveButtonClass, ErrorText } from "./ui";

export function DisconnectGoogleButton({ id }: { id: string }) {
  const t = useTranslations("settingsStatus.disconnectButton");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (!window.confirm(t("confirm")))
      return;
    setPending(true);
    setError(null);
    const result = await googleConnections_disconnect({ id });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    // The row disappears with this component, so the revoke warning travels in the URL.
    const { warning } = result.data as { warning: string | null };
    router.replace(warning ? "/settings/google?revoked=0" : "/settings/google");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={onClick} disabled={pending} className={destructiveButtonClass}>
        {t("disconnect")}
      </button>
      <ErrorText message={error} />
    </div>
  );
}
