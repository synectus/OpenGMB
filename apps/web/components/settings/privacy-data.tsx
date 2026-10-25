"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { workspaces_erase_data } from "../../app/_generated/actions";
import { LEGAL_PAGES } from "../../lib/legal";
import { destructiveButtonClass, ErrorText, inputClass, linkClass, Panel, secondaryButtonClass } from "../ui";

/** Export and delete everything SynGMB stores for one client. Delete is owner only and asks for the client's name. */
export function PrivacyData({
  workspaceId,
  workspaceName,
  canErase,
}: {
  workspaceId: string;
  workspaceName: string;
  canErase: boolean;
}) {
  const t = useTranslations("settings.privacyData");
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed === workspaceName;

  async function erase(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!matches) return;
    setPending(true);
    setError(null);
    const r = await workspaces_erase_data({ workspaceId, confirmName: typed });
    setPending(false);
    if (!r.ok) return setError(r.error.message);
    router.push("/workspaces");
    router.refresh();
  }

  return (
    <>
      <Panel
        title={t("downloadTitle")}
        description={t("downloadDescription")}
      >
        <div>
          <a
            href={`/api/workspaces/export?workspaceId=${workspaceId}`}
            download
            className={secondaryButtonClass}
            aria-label={t("downloadLabel", { name: workspaceName })}
          >
            {t("download")}
          </a>
        </div>
      </Panel>
      <Panel
        title={t("deleteTitle")}
        description={t("deleteDescription")}
      >
        <ul className="ml-5 list-disc text-sm">
          <li>{t("noteGoogle")}</li>
          <li>{t("noteAccounts")}</li>
          <li>{t("noteAudit")}</li>
        </ul>
        {canErase ? (
          <form onSubmit={erase} aria-label={t("deleteLabel", { name: workspaceName })} className="flex flex-col gap-2">
            <label htmlFor="confirm-name" className="text-sm font-medium">
              {t.rich("typeName", { name: workspaceName, strong: (chunks) => <strong>{chunks}</strong> })}
            </label>
            <input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className={`${inputClass} max-w-md`}
            />
            <div>
              <button type="submit" className={destructiveButtonClass} disabled={!matches || pending}>
                {t("deleteButton")}
              </button>
            </div>
            <ErrorText message={error} />
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>
        )}
      </Panel>
      {LEGAL_PAGES.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("howPrefix")}{" "}
          {LEGAL_PAGES.map((p, i) => (
            <span key={p.href}>
              {i > 0 ? ` ${t("and")} ` : ""}
              <Link href={p.href} className={linkClass}>
                {p.label.toLowerCase() === "privacy" ? t("privacyPolicy") : t("terms")}
              </Link>
            </span>
          ))}
          {t("howSuffix")}
        </p>
      )}
    </>
  );
}
