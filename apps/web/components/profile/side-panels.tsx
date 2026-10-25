import Link from "next/link";
import { useTranslations } from "next-intl";
import { linkClass } from "../ui";
import { h2Class, sectionClass } from "./section";

export function HowEditsWork({ writesOff }: { writesOff: boolean }) {
  const t = useTranslations("profile");
  return (
    <section aria-label={t("side.howTitle")} className={sectionClass}>
      <h2 className={h2Class}>{t("side.howTitle")}</h2>
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm">
        <li>{t("side.step1")}</li>
        <li>{t("side.step2")}</li>
        <li>
          {t.rich("side.step3", {
            link: (chunks) => (
              <Link href="/approvals" className={linkClass}>
                {chunks}
              </Link>
            ),
          })}
        </li>
        <li>{t("side.step4")}</li>
      </ol>
      {writesOff && (
        <p className="text-xs text-muted-foreground">{t("side.writesOff")}</p>
      )}
    </section>
  );
}
