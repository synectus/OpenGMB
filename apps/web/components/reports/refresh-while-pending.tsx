"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While a run is queued or running, refresh the page every 3 s, 20 times at most. */
export function RefreshWhilePending({ pending }: { pending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!pending) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 20) return clearInterval(t);
      router.refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [pending, router]);
  return null;
}
