import Link from "next/link";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { currentGoogleEnabled, currentIsMainHost } from "../../lib/host-branding";
import { SignInForm } from "../../components/sign-in-form";
import { LegalLinks } from "../../components/legal/legal-links";
import { linkClass } from "../../components/ui";
import { AuthCard } from "../../components/auth-card";
import { signUpHref } from "../../lib/sign-up-entry";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string }>;
}) {
  const { verified } = await searchParams;
  const t = await getTranslations("auth");
  const tShell = await getTranslations("shell");
  await connection(); // Google availability is read from runtime env, not baked in at build
  const mainHost = await currentIsMainHost();
  return (
    <AuthCard
      title={t("signInTitle")}
      description={t("signInDescription")}
      note={t("twoFactorNote")}
    >
      {verified === "1" ? (
        <p role="status" className="rounded-md bg-info-bg p-3 text-sm text-info">
          {t("emailConfirmed")}
        </p>
      ) : null}
      <SignInForm googleEnabled={await currentGoogleEnabled()} />
      {signUpHref ? (
        <p className="text-center text-sm text-foreground">
          {t("newToApp")}{" "}
          <Link href={signUpHref} className={linkClass}>
            {t("createAccountLink")}
          </Link>
        </p>
      ) : null}
      {mainHost ? (
        <p className="text-center text-sm text-foreground">
          {t("questions")}{" "}
          <Link href="/help" className={linkClass}>
            {tShell("helpCenter")}
          </Link>
        </p>
      ) : null}
      <LegalLinks hideContact={!mainHost} />
    </AuthCard>
  );
}
