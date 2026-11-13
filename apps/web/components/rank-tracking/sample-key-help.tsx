"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createContext, useContext, type ReactNode } from "react";
import { linkClass } from "../ui";

/** Set by the Rank tracking page for people who can save a DataForSEO key; `env` is true where the .env option exists (community edition). */
const Ctx = createContext<{ env: boolean } | null>(null);

export function SampleKeyHelpProvider({ value, children }: { value: { env: boolean } | null; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** After a "sample data" sentence: where to add the key. Nothing for people who cannot save one. */
export function KeyHelp() {
  const t = useTranslations("geogrid");
  const help = useContext(Ctx);
  if (!help) return null;
  return (
    <span>
      {" "}
      <Link href="/geogrid?view=usage#own-key" className={linkClass}>
        {t("key.addLink")}
      </Link>
      {help.env ? ` ${t("key.addEnv")}` : null}
    </span>
  );
}
