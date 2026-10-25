"use client";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";
import { buttonClass, ErrorText, Field } from "./ui";

/**
 * Asks for a reset link. The answer is the same whether or not the address has an account (the
 * server never says), so the only outcomes are "sent" and a rate-limit or network failure.
 * `disabled` is the server's call: email is not configured, so nothing could be sent.
 */
export function ForgotPasswordForm({ disabled }: { disabled: boolean }) {
  const t = useTranslations("authFlows");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    setPending(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({ email });
    setPending(false);
    if (error) return setError(error.status === 429 ? t("forgot.tooMany") : t("forgot.failed"));
    setSent(true);
  }

  if (sent) {
    return (
      <p role="status" className="rounded-md bg-info-bg p-3 text-sm text-info">
        {t("forgot.sent")}
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <fieldset disabled={disabled || pending} className="flex flex-col gap-4">
        <Field label={t("forgot.email")} id="email" type="email" autoComplete="email" required />
      </fieldset>
      <ErrorText message={error} />
      <button type="submit" className={`${buttonClass} w-full`} disabled={disabled || pending}>
        {pending ? t("forgot.sending") : t("forgot.send")}
      </button>
    </form>
  );
}
