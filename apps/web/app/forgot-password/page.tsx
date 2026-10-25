import Link from "next/link";
import { connection } from "next/server";
import { emailConfigured } from "@opengmb/core";
import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "../../components/forgot-password-form";
import { Pill } from "../../components/page-parts";
import { linkClass } from "../../components/ui";
import { AuthCard } from "../../components/auth-card";

export default async function ForgotPasswordPage() {
  const t = await getTranslations("authFlows");
  await connection(); // whether email is set up is read at request time, never baked in at build
  const live = emailConfigured();
  return (
    <AuthCard title={t("forgot.title")}>
      {live ? null : (
        <div className="flex flex-col items-start gap-2 rounded-md border border-warn-border bg-warn-bg p-3 text-sm text-warn">
          <Pill tone="warn">{t("forgot.notLive")}</Pill>
          <p>{t("forgot.notSetUp")}</p>
        </div>
      )}
      <ForgotPasswordForm disabled={!live} />
      <p className="text-center text-sm text-foreground">
        {t("forgot.remembered")}{" "}
        <Link href="/sign-in" className={linkClass}>
          {t("forgot.back")}
        </Link>
      </p>
    </AuthCard>
  );
}
