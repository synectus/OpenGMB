"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "./ui";
import { approveConsent, denyConsent } from "../app/oauth/consent/actions";

type Org = { orgId: string; name: string; readOnly: boolean };

const check = "size-4 accent-primary";

export function OAuthConsentForm({ oauthQuery, orgs }: { oauthQuery: string; orgs: Org[] }) {
  const t = useTranslations("oauthConsent");
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? "");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [autonomy, setAutonomy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = orgs.find((o) => o.orgId === orgId)?.readOnly ?? false;
  const effective = readOnly ? "read" : access;

  async function decide(approve: boolean) {
    setPending(true);
    setError(null);
    const result = approve
      ? await approveConsent(oauthQuery, { orgId, access: effective, fullAutonomy: effective === "write" && autonomy })
      : await denyConsent(oauthQuery);
    if (result.ok) {
      // A full navigation: a server action redirect to another origin would hit form-action 'self'.
      window.location.href = result.url;
      return;
    }
    setPending(false);
    setError(t(result.error));
  }

  const option = (value: "read" | "write", label: string, help: string, disabled: boolean) => (
    <label
      className={`flex items-start gap-2.5 rounded-control border p-3 text-sm ${
        effective === value ? "border-brand bg-brand-tint" : "border-border bg-card"
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="radio"
        name="access"
        checked={effective === value}
        disabled={disabled}
        onChange={() => setAccess(value)}
        className={`${check} mt-0.5`}
      />
      <span>
        <span className="block font-semibold">{label}</span>
        <span className="block text-muted-foreground">{help}</span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      {orgs.length > 1 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="org" className="text-sm font-medium">
            {t("account")}
          </label>
          <select id="org" value={orgId} onChange={(e) => setOrgId(e.target.value)} className={inputClass}>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div role="radiogroup" aria-label={t("access")} className="flex flex-col gap-2">
        {option("read", t("readOnly"), t("readOnlyHelp"), false)}
        {option("write", t("readWrite"), t("readWriteHelp"), readOnly)}
        {readOnly ? <p className="text-[13px] text-muted-foreground">{t("readOnlyForced")}</p> : null}
      </div>
      <label className={`flex items-start gap-2.5 text-sm ${effective === "write" ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
        <input
          type="checkbox"
          checked={effective === "write" && autonomy}
          disabled={effective !== "write"}
          onChange={(e) => setAutonomy(e.target.checked)}
          className={`${check} mt-0.5`}
        />
        <span>
          <span className="block font-semibold">{t("autonomy")}</span>
          <span className="block text-muted-foreground">{t("autonomyHelp")}</span>
        </span>
      </label>
      <ErrorText message={error} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className={`${buttonClass} w-full sm:w-auto`} disabled={pending} onClick={() => decide(true)}>
          {pending ? t("working") : t("approve")}
        </button>
        <button type="button" className={`${secondaryButtonClass} w-full sm:w-auto`} disabled={pending} onClick={() => decide(false)}>
          {t("deny")}
        </button>
      </div>
    </div>
  );
}
