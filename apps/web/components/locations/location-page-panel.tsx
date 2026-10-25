"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { locationPages_set } from "../../app/_generated/actions";
import { buttonClass, ErrorText, linkClass, secondaryButtonClass } from "../ui";

/** Publish or unpublish the public page of one location (X3). Shows the address once it is live. */
export function LocationPagePanel({ locationId, published, path, canManage }: { locationId: string; published: boolean; path: string | null; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function change(next: boolean) {
    setBusy(true);
    const r = await locationPages_set({ locationId, published: next });
    setBusy(false);
    if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
    else {
      setError(null);
      router.refresh();
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {published
          ? "Live. Anyone with the address can see it, and search engines may list it."
          : "Off. Nobody can see a page for this location until you publish it."}
      </p>
      {published && path && (
        <a href={path} target="_blank" rel="noreferrer noopener" className={linkClass}>
          {path}
        </a>
      )}
      {canManage && (
        <div>
          {published ? (
            <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => change(false)}>
              Unpublish page
            </button>
          ) : (
            <button type="button" disabled={busy} className={buttonClass} onClick={() => change(true)}>
              Publish page
            </button>
          )}
        </div>
      )}
      <ErrorText message={error} />
    </div>
  );
}
