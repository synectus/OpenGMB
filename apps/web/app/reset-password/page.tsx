import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ResetLinkInvalid, ResetPasswordForm } from "../../components/reset-password-form";
import { linkClass } from "../../components/ui";
import { AuthCard } from "../../components/auth-card";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams; // reading searchParams makes this page dynamic
  const t = await getTranslations("authFlows");
  return (
    <AuthCard title={t("reset.title")}>
      {token ? <ResetPasswordForm token={token} /> : <ResetLinkInvalid />}
      <p className="text-center text-sm text-foreground">
        <Link href="/sign-in" className={linkClass}>
          {t("forgot.back")}
        </Link>
      </p>
    </AuthCard>
  );
}
