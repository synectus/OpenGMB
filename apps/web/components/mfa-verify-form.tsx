"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- full page load on purpose so server components see the new session cookie */
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { backupCodesLeftAction } from "../app/mfa/verify/actions";
import { isLowBackupCodes } from "../lib/account";
import { authClient } from "../lib/auth-client";
import { buttonClass, ErrorText, Field, linkClass } from "./ui";

export function MfaVerifyForm() {
  const t = useTranslations("authFlows");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [lowLeft, setLowLeft] = useState<number | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(error.message ?? t("setup.invalidCode"));
    if (useBackup) {
      const left = await backupCodesLeftAction();
      if (left !== null && isLowBackupCodes(left)) return setLowLeft(left);
    }
    window.location.href = "/";
  }

  if (lowLeft !== null) {
    return (
      <div
        role="status"
        className="flex flex-col items-start gap-2 rounded-md border border-warn-border bg-warn-bg p-3 text-sm text-warn"
      >
        <span>{t("verify.lowCodes", { left: lowLeft })}</span>
        <Link href="/account" className={linkClass}>
          {t("verify.account")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {useBackup ? (
          <Field
            label={t("verify.backupCode")}
            id="code"
            autoComplete="off"
            placeholder="xxxxx-xxxxx"
            required
            readOnly={pending}
          />
        ) : (
          <Field
            label={t("verify.codeLabel")}
            id="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="123456"
            autoComplete="one-time-code"
            required
            readOnly={pending}
          />
        )}
        <ErrorText message={error} />
        {/* The smoke test clicks this by exact name "Verify": no other button may carry it. */}
        <button type="submit" className={`${buttonClass} w-full`} disabled={pending}>
          {pending ? t("setup.checking") : t("verify.verify")}
        </button>
      </form>
      <div className="flex flex-col items-center gap-2 text-sm">
        <button
          type="button"
          className={linkClass}
          onClick={() => {
            setUseBackup(!useBackup);
            setError(null);
          }}
        >
          {useBackup ? t("verify.useAuthenticator") : t("verify.useBackup")}
        </button>
        {useBackup ? (
          <p className="text-center text-muted-foreground">
            {t("verify.lost")}
          </p>
        ) : null}
        <p className="text-muted-foreground">
          {t("verify.wrongPerson")}{" "}
          <Link href="/sign-in" className={linkClass}>
            {t("verify.startAgain")}
          </Link>
        </p>
      </div>
    </div>
  );
}
