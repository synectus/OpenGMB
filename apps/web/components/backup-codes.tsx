"use client";
import { useTranslations } from "next-intl";
import { BACKUP_CODES_FILE, backupCodesText } from "../lib/auth-pages";
import { secondaryButtonClass } from "./ui";

/**
 * Freshly made backup codes: a list (never <code>: /mfa/setup must keep exactly one <code>), plus
 * Copy and Download. The codes exist only in this component's props; nothing stores them.
 */
export function BackupCodes({ codes }: { codes: string[] }) {
  const t = useTranslations("authFlows");
  const text = backupCodesText(codes);
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label={t("backupCodes.label")}
        className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted p-4 font-mono text-sm"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          {t("backupCodes.copy")}
        </button>
        <a
          className={secondaryButtonClass}
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
          download={BACKUP_CODES_FILE}
        >
          {t("backupCodes.download")}
        </a>
      </div>
    </div>
  );
}
