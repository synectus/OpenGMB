"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- full page load on purpose so server components see the new session cookie */
import { authClient } from "../lib/auth-client";
import { secondaryButtonClass } from "./ui";

export async function signOut(): Promise<void> {
  await authClient.signOut();
  window.location.href = "/sign-in";
}

export function SignOutButton() {
  return (
    <button type="button" className={secondaryButtonClass} onClick={() => void signOut()}>
      Sign out
    </button>
  );
}
