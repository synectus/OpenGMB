"use client";
import { useTranslations } from "next-intl";
import { addressProblem, type ProfileForm } from "../../lib/profile-editor";
import { inputClass } from "../ui";
import { EditorSection, fieldLabelClass, hintClass, usePhrase } from "./section";

/** Address and store code. Changing the address can send the location back to verification, so say so up front. */
export function AddressAndStoreCode({
  form,
  onChange,
}: {
  form: ProfileForm;
  onChange: (patch: Partial<ProfileForm>) => void;
}) {
  const t = useTranslations("profile");
  const phrase = usePhrase();
  const a = form.address;
  const set = (p: Partial<typeof a>) => onChange({ address: { ...a, ...p } });
  const problem = addressProblem(a);
  return (
    <EditorSection label="Address and store code">
      <p role="note" className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
        {t("address.verifyWarning")}
      </p>
      <label className={fieldLabelClass}>
        {t("address.lines")}
        <textarea className={`${inputClass} min-h-20`} rows={3} value={a.lines} onChange={(e) => set({ lines: e.target.value })} />
        <span className={`${hintClass} font-normal`}>{t("address.linesHint")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldLabelClass}>
          {t("address.city")}
          <input className={inputClass} value={a.city} onChange={(e) => set({ city: e.target.value })} />
        </label>
        <label className={fieldLabelClass}>
          {t("address.region")}
          <input className={inputClass} value={a.region} onChange={(e) => set({ region: e.target.value })} />
        </label>
        <label className={fieldLabelClass}>
          {t("address.postal")}
          <input className={inputClass} value={a.postal} onChange={(e) => set({ postal: e.target.value })} />
        </label>
        <label className={fieldLabelClass}>
          {t("address.country")}
          <input className={inputClass} maxLength={2} placeholder="US" value={a.country} onChange={(e) => set({ country: e.target.value })} />
        </label>
      </div>
      {problem && <p role="alert" className="m-0 text-sm text-bad">{phrase(problem)}</p>}
      <label className={fieldLabelClass}>
        {t("address.storeCode")}
        <input className={inputClass} value={form.storeCode} placeholder={t("address.notSet")} onChange={(e) => onChange({ storeCode: e.target.value })} />
        <span className={`${hintClass} font-normal`}>{t("address.storeCodeHint")}</span>
      </label>
    </EditorSection>
  );
}
