import { redirectClientHome } from "../../../lib/client-home";
import { AccountSections } from "../../../components/account-sections";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";

// Reached from the account menu; no sidebar item is current (lib/nav.test.ts).
export default async function AccountPage() {
  const { userId, email } = await requireUser();
  const { home } = await actorContextFor(userId);
  redirectClientHome(home, "account"); // clients never see the agency shell
  return <AccountSections userId={userId} email={email} />;
}
