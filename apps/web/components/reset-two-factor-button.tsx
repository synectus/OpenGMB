"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { members_resetTwoFactor } from "../app/_generated/actions";
import { resetTwoFactorConfirm, resetTwoFactorDone } from "../lib/two-factor-reset";
import { ErrorText, secondaryButtonClass } from "./ui";

export function ResetTwoFactorButton({ membershipId, name }: { membershipId: string; name: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (!window.confirm(resetTwoFactorConfirm(name))) return;
    setPending(true);
    setError(null);
    const result = await members_resetTwoFactor({ membershipId });
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <span role="status" className="text-sm font-semibold text-good">
        {resetTwoFactorDone(name)}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={`${secondaryButtonClass} border-bad-border text-bad hover:bg-bad-bg`}
      >
        Reset two-factor
      </button>
      <ErrorText message={error} />
    </>
  );
}
