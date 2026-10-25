"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { workspaces_setHipaa, workspaces_setSenderIdentity } from "../app/_generated/actions";
import { buttonClass, ErrorText, inputClass } from "./ui";

export type SenderValues = {
  senderLegalName: string | null;
  senderPostalAddress: string | null;
  senderCompanyNumber: string | null;
  senderPhone: string | null;
  senderWebsite: string | null;
  hipaaCoveredEntity: boolean;
};

/** Who review request emails are from (legal name and postal address are required to send), and whether the business is a HIPAA covered entity. */
export function WorkspaceSenderForm({
  workspaceId,
  workspaceName,
  initial,
  canConfigure,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: SenderValues;
  canConfigure: boolean;
}) {
  const t = useTranslations("settings.senderForm");
  const router = useRouter();
  const [legalName, setLegalName] = useState(initial.senderLegalName ?? "");
  const [address, setAddress] = useState(initial.senderPostalAddress ?? "");
  const [number, setNumber] = useState(initial.senderCompanyNumber ?? "");
  const [phone, setPhone] = useState(initial.senderPhone ?? "");
  const [website, setWebsite] = useState(initial.senderWebsite ?? "");
  const [hipaa, setHipaa] = useState(initial.hipaaCoveredEntity);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const idDirty =
    legalName !== (initial.senderLegalName ?? "") ||
    address !== (initial.senderPostalAddress ?? "") ||
    number !== (initial.senderCompanyNumber ?? "") ||
    phone !== (initial.senderPhone ?? "") ||
    website !== (initial.senderWebsite ?? "");
  const hipaaDirty = hipaa !== initial.hipaaCoveredEntity;
  const idReady = legalName.trim().length >= 2 && address.trim().length >= 5;
  const field = (label: string, value: string, set: (v: string) => void, extra: { required?: boolean; help?: string; multiline?: boolean } = {}) => (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {extra.multiline ? (
        <textarea className={inputClass} rows={2} value={value} required={extra.required} disabled={!canConfigure || pending} maxLength={400} onChange={(e) => { setSaved(false); set(e.target.value); }} />
      ) : (
        <input className={inputClass} value={value} required={extra.required} disabled={!canConfigure || pending} maxLength={200} onChange={(e) => { setSaved(false); set(e.target.value); }} />
      )}
      {extra.help && <span className="text-xs font-normal text-muted-foreground">{extra.help}</span>}
    </label>
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    if (idDirty && idReady) {
      const r = await workspaces_setSenderIdentity({
        workspaceId,
        legalName,
        postalAddress: address,
        companyNumber: number || null,
        phone: phone || null,
        website: website || null,
      });
      if (!r.ok) {
        setPending(false);
        return setError(`${r.error.code}: ${r.error.message}`);
      }
    }
    if (hipaaDirty) {
      const r = await workspaces_setHipaa({ workspaceId, hipaaCoveredEntity: hipaa });
      if (!r.ok) {
        setPending(false);
        return setError(`${r.error.code}: ${r.error.message}`);
      }
    }
    setPending(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-lg font-bold">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">{t("intro", { name: workspaceName })}</p>
      {field(t("legalName"), legalName, setLegalName, { required: true })}
      {field(t("postalAddress"), address, setAddress, { required: true, multiline: true })}
      {field(t("companyNumber"), number, setNumber, { help: t("companyNumberHelp") })}
      {field(t("phone"), phone, setPhone)}
      {field(t("website"), website, setWebsite)}
      <h3 className="mt-2 font-display text-base font-bold">{t("hipaaTitle")}</h3>
      <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
        {t("hipaaLabel")}
        <select
          className={inputClass}
          value={hipaa ? "yes" : "no"}
          disabled={!canConfigure || pending}
          onChange={(e) => {
            setSaved(false);
            setHipaa(e.target.value === "yes");
          }}
        >
          <option value="no">{t("no")}</option>
          <option value="yes">{t("yes")}</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">{hipaa ? t("hipaaOn") : t("hipaaHelp")}</p>
      <ErrorText message={error} />
      {canConfigure ? (
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={pending || (!hipaaDirty && !(idDirty && idReady))}>
            {pending ? t("saving") : t("save")}
          </button>
          {saved && <span className="text-sm text-good" role="status">{t("saved")}</span>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ownersOnly")}</p>
      )}
    </form>
  );
}
