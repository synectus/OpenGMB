import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthError, requireAuthenticatedUser } from "@opengmb/core";
import { getAuth, userHasPassword } from "../../../lib/auth";
import { MfaSetupForm } from "../../../components/mfa-setup-form";
import { AuthCard } from "../../../components/auth-card";
import { linkClass } from "../../../components/ui";

// Needs a session but not MFA, so it sits outside the (app) group. Two-factor is optional (2026-10-30), so
// anyone signed in without it may enrol here (from Settings or the Home card). MFA_REQUIRED from
// requireAuthenticatedUser means a platform admin, for whom it is mandatory: no "Not now" link.
export default async function MfaSetupPage() {
  const t = await getTranslations("authFlows");
  const h = await headers();
  const session = await getAuth().api.getSession({ headers: h });
  let required = false;
  try {
    requireAuthenticatedUser(session);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    if (e.code === "UNAUTHENTICATED") redirect("/sign-in");
    required = true;
  }
  if (session!.user.twoFactorEnabled) redirect("/");
  const hasPassword = await userHasPassword(session!.user.id);
  return (
    <AuthCard
      title={t("setup.title")}
      note={required ? t("setup.noteRequired") : t("setup.note")}
    >
      <MfaSetupForm hasPassword={hasPassword} />
      {required ? null : (
        <Link href="/" className={`${linkClass} text-center`}>
          {t("setup.skip")}
        </Link>
      )}
    </AuthCard>
  );
}
