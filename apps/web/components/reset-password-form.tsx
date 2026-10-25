"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";
import { PasswordField } from "./password-field";
import { buttonClass, ErrorText, linkClass } from "./ui";

/** Sets the new password for a reset token. The password rules are Better-Auth's, same as sign-up. */
export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("authFlows");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const newPassword = String(f.get("password"));
    if (newPassword !== String(f.get("confirm"))) return setError(t("reset.mismatch"));
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (!error) return setDone(true);
    if (error.code === "INVALID_TOKEN") return setInvalid(true);
    const clientError = error.status >= 400 && error.status < 500;
    setError(clientError && error.message ? error.message : t("reset.failed"));
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="rounded-md bg-info-bg p-3 text-sm text-info">
          {t("reset.done")} {t("reset.mfaNote")}
        </p>
        <Link href="/sign-in" className={`${buttonClass} w-full`}>
          {t("reset.signIn")}
        </Link>
      </div>
    );
  }
  if (invalid) return <ResetLinkInvalid />;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <fieldset disabled={pending} className="flex flex-col gap-4">
        <PasswordField
          label={t("reset.password")}
          id="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        <PasswordField
          label={t("reset.confirm")}
          id="confirm"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </fieldset>
      <ErrorText message={error} />
      <button type="submit" className={`${buttonClass} w-full`} disabled={pending}>
        {pending ? t("reset.saving") : t("reset.submit")}
      </button>
    </form>
  );
}

/** Shown for an expired or used token, and when the link has no token at all. */
export function ResetLinkInvalid() {
  const t = useTranslations("authFlows");
  return (
    <div className="flex flex-col gap-4">
      <p role="alert" className="rounded-md bg-bad-bg p-3 text-sm font-medium text-bad">
        {t("reset.invalid")}
      </p>
      <Link href="/forgot-password" className={linkClass}>
        {t("reset.requestNew")}
      </Link>
    </div>
  );
}
