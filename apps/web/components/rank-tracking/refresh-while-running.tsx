"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetches the server page every 15 s while a run is queued or running. Renders nothing. */
export function RefreshWhileRunning({ everyMs = 15_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
