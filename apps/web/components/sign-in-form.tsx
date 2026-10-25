"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- full page load on purpose so server components see the new session cookie */
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";
import { PasswordField } from "./password-field";
import { buttonClass, ErrorText, Field, linkClass, secondaryButtonClass } from "./ui";

/** "or" rule between the password form and the Google button. */
export function OrDivider() {
  const t = useTranslations("common");
  return (
    <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      {t("or")}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Never "Sign in with Google": the smoke test finds the "Sign in" button by substring. */
export function GoogleButton() {
  const t = useTranslations("auth");
  return (
    <button
      type="button"
      className={`${secondaryButtonClass} w-full`}
      onClick={() =>
        authClient.signIn.social({
          provider: "google",
          callbackURL: "/",
          errorCallbackURL: "/sign-in",
        })
      }
    >
      {t("continueWithGoogle")}
    </button>
  );
}

export function SignInForm({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations("auth");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [linkPending, setLinkPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    // On a 2FA challenge the client plugin's onTwoFactorRedirect navigates to /mfa/verify.
    const { data, error } = await authClient.signIn.email({
      email: String(f.get("email")),
      password: String(f.get("password")),
    });
    setPending(false);
    if (error?.status === 403) {
      return setError(t("confirmEmailFirst"));
    }
    if (error) return setError(error.message ?? t("signInFailed"));
    if (data && !("twoFactorRedirect" in data && data.twoFactorRedirect)) {
      window.location.href = "/";
    }
  }

  // Client users can skip the password: the address typed above gets a one-use sign-in link.
  async function emailLink(form: HTMLFormElement | null) {
    const email = String(new FormData(form ?? undefined).get("email") ?? "").trim();
    setLinkNote(null);
    if (!email) return setError(t("enterEmailFirst"));
    setError(null);
    setLinkPending(true);
    const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/" });
    setLinkPending(false);
    if (error) return setError(error.status === 429 ? (error.message ?? t("linkFailed")) : t("linkFailed"));
    setLinkNote(t("linkSent", { email }));
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <fieldset disabled={pending} className="flex flex-col gap-4">
          <Field label={t("email")} id="email" type="email" autoComplete="email" required />
          <div className="flex flex-col gap-2">
            <PasswordField
              label={t("password")}
              id="password"
              autoComplete="current-password"
              required
            />
            <Link href="/forgot-password" className={`${linkClass} self-end text-[13px]`}>
              {t("forgotPassword")}
            </Link>
          </div>
        </fieldset>
        <ErrorText message={error} />
        {linkNote ? (
          <p role="status" className="rounded-md bg-info-bg p-3 text-sm text-info">
            {linkNote}
          </p>
        ) : null}
        <button type="submit" className={`${buttonClass} w-full`} disabled={pending}>
          {pending ? t("signingIn") : t("signIn")}
        </button>
        <button
          type="button"
          className={`${linkClass} self-center text-[13px]`}
          disabled={pending || linkPending}
          onClick={(e) => void emailLink(e.currentTarget.form)}
        >
          {linkPending ? t("sendingLink") : t("emailLinkInstead")}
        </button>
      </form>
      {googleEnabled ? (
        <>
          <OrDivider />
          <GoogleButton />
        </>
      ) : null}
    </div>
  );
}
