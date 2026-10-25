"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- full page load on purpose so server components see the new session cookie */
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { authClient } from "../lib/auth-client";
import { secretGroups } from "../lib/auth-pages";
import { BackupCodes } from "./backup-codes";
import { PasswordField } from "./password-field";
import { buttonClass, ErrorText, Field, secondaryButtonClass } from "./ui";

const STEPS = ["confirm", "scan", "save"] as const;

function Steps({ current, skipFirst }: { current: number; skipFirst: boolean }) {
  const t = useTranslations("authFlows");
  return (
    <ol aria-label={t("setup.steps")} className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
      {STEPS.map((label, i) => {
        if (skipFirst && i === 0) return null;
        const done = i < current;
        const now = i === current;
        return (
          <li
            key={label}
            aria-current={now ? "step" : undefined}
            className={`flex items-center gap-2 ${
              now ? "font-bold text-foreground" : done ? "font-medium text-foreground" : "font-medium text-muted-foreground"
            }`}
          >
            <span
              aria-hidden
              className={`flex size-6 items-center justify-center rounded-full border text-xs ${
                done
                  ? "border-good-border bg-good-bg text-good"
                  : now
                    ? "border-foreground bg-foreground text-background"
                    : "border-input bg-card text-muted-foreground"
              }`}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            {t(`setup.step.${label}`)}
          </li>
        );
      })}
    </ol>
  );
}

type Enrolment = { qr: string; secret: string; backupCodes: string[] };

export function MfaSetupForm({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("authFlows");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Google-only accounts skip step 1, so their list starts at step 2.
  const skipFirst = !hasPassword;

  async function onStart(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    setPending(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.enable(hasPassword ? { password } : {});
    if (error || data?.method !== "totp") {
      setPending(false);
      return setError(error?.message ?? t("setup.couldNotStart"));
    }
    const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
    setEnrolment({
      qr: await QRCode.toDataURL(data.totpURI, { width: 200, margin: 1 }),
      secret,
      backupCodes: data.backupCodes,
    });
    setPending(false);
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(error.message ?? t("setup.invalidCode"));
    setBackupCodes(enrolment?.backupCodes ?? []);
  }

  if (backupCodes) {
    return (
      <div className="flex flex-col gap-4">
        <Steps current={2} skipFirst={skipFirst} />
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-good-border bg-good-bg p-3 text-sm font-semibold text-good"
        >
          <Check aria-hidden className="size-4" />
          {t("setup.isOn")}
        </p>
        <p className="text-sm">
          {t("setup.saveCodes")}
        </p>
        <BackupCodes codes={backupCodes} />
        <button
          type="button"
          className={`${buttonClass} w-full`}
          onClick={() => (window.location.href = "/")}
        >
          {t("setup.continue")}
        </button>
      </div>
    );
  }

  if (!enrolment) {
    return (
      <form onSubmit={onStart} className="flex flex-col gap-4">
        <Steps current={skipFirst ? 1 : 0} skipFirst={skipFirst} />
        {hasPassword ? (
          <>
            <p className="text-sm">{t("setup.enterPassword")}</p>
            <PasswordField
              label={t("setup.confirmPassword")}
              id="password"
              autoComplete="current-password"
              required
              disabled={pending}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("setup.skippedGoogle")}</p>
        )}
        <ErrorText message={error} />
        <button type="submit" className={`${buttonClass} w-full`} disabled={pending}>
          {t("setup.start")}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onVerify} className="flex flex-col gap-4">
      <Steps current={1} skipFirst={skipFirst} />
      <p className="text-sm">
        {t("setup.scan")}
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL made in the browser */}
      <img
        src={enrolment.qr}
        alt={t("setup.qrAlt")}
        width={200}
        height={200}
        className="self-center rounded-md border border-border bg-card p-2"
      />
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted-foreground">{t("setup.cantScan")}</span>
        <div className="flex flex-wrap items-center gap-2">
          {/* The only <code> on the page, and its text is the secret unchanged: the smoke test
              reads it. Groups are spans with no text between them, so no space reaches otplib. */}
          <code className="flex flex-wrap gap-x-1.5 rounded-md bg-secondary px-2 py-1 font-mono">{secretGroups(enrolment.secret).map((g, i) => <span key={i}>{g}</span>)}</code>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void navigator.clipboard.writeText(enrolment.secret)}
          >
            {t("setup.copyKey")}
          </button>
        </div>
      </div>
      <Field
        label={t("setup.codeLabel")}
        id="code"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        placeholder="123456"
        autoComplete="one-time-code"
        required
        readOnly={pending}
      />
      <ErrorText message={error} />
      {error ? (
        <p className="text-sm text-muted-foreground">
          {t("setup.codesChange")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={`${buttonClass} w-full`} disabled={pending}>
          {t("setup.verify")}
        </button>
        {pending ? (
          <span role="status" className="text-sm text-muted-foreground">
            {t("setup.checking")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
