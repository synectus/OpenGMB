"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- full page load on purpose so server components see the new session state */
import { Check } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";
import {
  isLowBackupCodes,
  newPasswordProblem,
  passwordChangeError,
} from "../lib/account";
import { LOCALES, LOCALE_NAMES, parseLocale } from "../lib/i18n";
import { setDensity, setLanguage, setTheme } from "../lib/preferences-actions";
import { parseTheme, type Density, type Theme } from "../lib/preferences";
import { BackupCodes } from "./backup-codes";
import { Pill } from "./page-parts";
import { PasswordField } from "./password-field";
import { buttonClass, ErrorText, Field, secondaryButtonClass } from "./ui";

const fieldError = "text-sm font-medium text-bad";

export function ProfileForm({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = String(new FormData(e.currentTarget).get("name")).trim();
    setPending(true);
    setError(null);
    setSaved(false);
    const { error } = await authClient.updateUser({ name: next });
    setPending(false);
    if (error) return setError(error.message ?? t("saveNameFailed"));
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field
        label={t("yourName")}
        id="name"
        autoComplete="name"
        defaultValue={name}
        required
        onChange={() => setSaved(false)}
      />
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("signInEmail")}</span>
        <span className="flex flex-wrap items-center gap-2">
          {email} <Pill>{tc("notLive")}</Pill>
        </span>
        <span className="text-muted-foreground">{t("emailChangeUnavailable")}</span>
      </div>
      <ErrorText message={error} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass} disabled={pending}>
          {pending ? tc("saving") : t("saveName")}
        </button>
        {saved ? (
          <span role="status" className="flex items-center gap-1 text-sm font-semibold text-good">
            <Check aria-hidden className="size-4" />
            {tc("saved")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function PasswordForm() {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [errors, setErrors] = useState<{ current?: string; repeat?: string; form?: string }>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const currentPassword = String(f.get("current-password"));
    const newPassword = String(f.get("new-password"));
    setDone(false);
    const mismatch = newPasswordProblem(newPassword, String(f.get("repeat-password")));
    if (mismatch) return setErrors({ repeat: mismatch });
    setErrors({});
    setPending(true);
    // Note: other devices are signed out (Better-Auth deletes every session of the user
    // and gives this browser a new one).
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) {
      const m = passwordChangeError(error);
      return setErrors(m.field === "current" ? { current: m.message } : { form: m.message });
    }
    form.reset();
    setDone(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <PasswordField
        label={t("currentPassword")}
        id="current-password"
        autoComplete="current-password"
        required
        aria-invalid={errors.current ? true : undefined}
        aria-describedby={errors.current ? "current-password-error" : undefined}
      />
      {errors.current ? (
        <span id="current-password-error" className={fieldError}>
          {errors.current}
        </span>
      ) : null}
      <PasswordField
        label={t("newPassword")}
        id="new-password"
        autoComplete="new-password"
        minLength={8}
        required
      />
      <PasswordField
        label={t("repeatPassword")}
        id="repeat-password"
        autoComplete="new-password"
        minLength={8}
        required
        aria-invalid={errors.repeat ? true : undefined}
        aria-describedby={errors.repeat ? "repeat-password-error" : undefined}
      />
      {errors.repeat ? (
        <span id="repeat-password-error" className={fieldError}>
          {errors.repeat}
        </span>
      ) : null}
      <ErrorText message={errors.form ?? null} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass} disabled={pending}>
          {pending ? tc("saving") : t("changePassword")}
        </button>
        {done ? (
          <span role="status" className="text-sm font-semibold text-good">
            {t("passwordChanged")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function TwoFactorPanel({
  hasPassword,
  left,
  total,
}: {
  hasPassword: boolean;
  left: number;
  total: number;
}) {
  const t = useTranslations("twoFactor");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const body = hasPassword ? { password } : {};

  async function makeCodes() {
    if (!window.confirm(t("confirmMake"))) return;
    setPending(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.generateBackupCodes(body);
    setPending(false);
    if (error || !data) return setError(error?.message ?? t("couldNotMake"));
    setCodes(data.backupCodes);
    setPassword("");
  }

  async function resetApp() {
    if (
      !window.confirm(
        t("confirmReset"),
      )
    )
      return;
    setPending(true);
    setError(null);
    // No reset endpoint exists: disable, then the normal setup. The gate (MFA_REQUIRED) keeps the
    // account locked to /mfa/setup until a new app is verified.
    const { error } = await authClient.twoFactor.disable(body);
    if (error) {
      setPending(false);
      return setError(error.message ?? t("couldNotReset"));
    }
    window.location.href = "/mfa/setup";
  }

  const shownLeft = codes ? total : left;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-good">
        <Check aria-hidden className="size-4" />
        {t("on")}
      </p>
      {!codes && isLowBackupCodes(left) ? (
        <p role="status" className="rounded-md border border-warn-border bg-warn-bg p-3 text-warn">
          <strong>{t("lowHeadline", { left })}</strong> {t("lowAdvice")}
        </p>
      ) : null}
      {hasPassword ? (
        <div className="flex flex-col gap-1">
          <PasswordField
            label={t("confirmPassword")}
            id="two-factor-password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="text-muted-foreground">
            {t("passwordNeeded")}
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{t("codesLine", { left: shownLeft, total })}</span>
        <button type="button" className={secondaryButtonClass} disabled={pending} onClick={makeCodes}>
          {t("makeNew")}
        </button>
        <span className="text-muted-foreground">{t("makingTurnsOff")}</span>
      </div>
      {codes ? (
        <>
          <p role="status" className="rounded-md border border-good-border bg-good-bg p-3 font-semibold text-good">
            {t("newReady")}
          </p>
          <BackupCodes codes={codes} />
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={`${secondaryButtonClass} border-bad-border text-bad hover:bg-bad-bg`}
          disabled={pending}
          onClick={resetApp}
        >
          {t("resetApp")}
        </button>
        <span className="text-muted-foreground">
          {t("resetNote")}
        </span>
      </div>
      <ErrorText message={error} />
      <p className="text-muted-foreground">
        {t("required")}
      </p>
    </div>
  );
}

const radio =
  "size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// Module-level so the react-hooks/immutability rule does not read it as a render-time mutation.
function applyTheme(next: Theme) {
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
}

export function DisplayForm({ theme, density }: { theme: Theme; density: Density }) {
  const router = useRouter();
  const t = useTranslations("shell");
  const ta = useTranslations("account");
  const locale = useLocale();
  const [, startTransition] = useTransition();

  function onTheme(value: string) {
    const next = parseTheme(value);
    // Same as the account menu: apply at once; the cookie makes it stick.
    applyTheme(next);
    startTransition(async () => {
      await setTheme(next);
      router.refresh();
    });
  }

  function onDensity(value: string) {
    startTransition(async () => {
      await setDensity(value);
      router.refresh();
    });
  }

  function onLanguage(value: string) {
    startTransition(async () => {
      await setLanguage(parseLocale(value));
      router.refresh();
    });
  }

  const groups = [
    {
      legend: ta("theme"),
      name: "theme",
      value: theme,
      on: onTheme,
      options: [
        ["light", t("light")],
        ["dark", t("dark")],
        ["system", t("system")],
      ],
    },
    {
      legend: ta("density"),
      name: "density",
      value: density,
      on: onDensity,
      options: [
        ["comfortable", t("comfortable")],
        ["compact", t("compact")],
      ],
    },
    {
      legend: ta("language"),
      name: "language",
      value: locale,
      on: onLanguage,
      options: LOCALES.map((l) => [l, LOCALE_NAMES[l]] as const),
    },
  ] as const;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap gap-8">
        {groups.map((g) => (
          <fieldset key={g.name} className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">{g.legend}</legend>
            {g.options.map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={g.name}
                  value={value}
                  defaultChecked={g.value === value}
                  onChange={() => g.on(value)}
                  className={radio}
                />
                {label}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <p className="text-muted-foreground">{ta("displayHint")}</p>
      <p className="text-muted-foreground">{ta("languageHint")}</p>
    </div>
  );
}
