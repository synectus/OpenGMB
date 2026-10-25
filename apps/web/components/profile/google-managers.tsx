"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { locationManagersList } from "@opengmb/core";
import { locationManagers_list } from "../../app/_generated/actions";
import { runCall } from "../post-card";
import { ErrorText, secondaryButtonClass } from "../ui";
import { h2Class, hintClass, sectionClass } from "./section";

type Managers = Awaited<ReturnType<(typeof locationManagersList)["handler"]>>["managers"];

/** Who manages the location on Google. Read only, and read when asked: each read is a Google call. */
export function GoogleManagers({ locationId }: { locationId: string }) {
  const t = useTranslations("profile");
  const [phase, setPhase] = useState<"closed" | "loading" | "ready">("closed");
  const [managers, setManagers] = useState<Managers>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setPhase("loading");
    setError(null);
    const r = await runCall<{ managers: Managers }>(() => locationManagers_list({ locationId }) as never);
    if ("error" in r) {
      setError(r.error);
      return setPhase("closed");
    }
    setManagers(r.data.managers);
    setPhase("ready");
  }

  return (
    <section aria-label={t("side.managersTitle")} className={sectionClass}>
      <h2 className={h2Class}>{t("side.managersTitle")}</h2>
      <p className="text-sm text-muted-foreground">{t("side.managersNote")}</p>
      {phase === "closed" && (
        <div>
          <button type="button" className={secondaryButtonClass} onClick={load}>
            {t("side.managersLoad")}
          </button>
        </div>
      )}
      {phase === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("side.managersLoading")}
        </p>
      )}
      <ErrorText message={error} />
      {phase === "ready" && managers.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">{t("side.managersNone")}</p>
      )}
      {phase === "ready" && managers.length > 0 && (
        <ul aria-label={t("side.managersTitle")} className="m-0 flex list-none flex-col gap-2 p-0">
          {managers.map((m, i) => (
            <li key={i} className="flex flex-col text-sm">
              <span className="font-medium">{m.name}</span>
              <span className={hintClass}>
                {t(`side.managerRole.${m.role}`)}
                {m.pendingInvitation ? ` · ${t("side.managersPending")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
