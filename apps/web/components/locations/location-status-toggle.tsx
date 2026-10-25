"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { locations_setStatus } from "../../app/_generated/actions";
import { setStatusOutcome } from "../../lib/locations";
import { secondaryButtonClass } from "../ui";

export function LocationStatusToggle({
  id,
  name,
  status,
}: {
  id: string;
  name: string;
  status: "active" | "inactive";
}) {
  const t = useTranslations("locations");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const next = status === "active" ? "inactive" : "active";
  const label = next === "active" ? t("activate") : t("deactivate");
  const toggle = (
    <button
      type="button"
      disabled={pending}
      aria-label={next === "active" ? t("activateAria", { name }) : t("deactivateAria", { name })}
      className={`${secondaryButtonClass} min-h-9 px-3`}
      onClick={() =>
        start(async () => {
          setError(null);
          setOpen(false);
          const o = setStatusOutcome(await locations_setStatus({ locationIds: [id], status: next }));
          setError(
            o === null ? null : o === "conflict" ? t("conflictMessage") : o === "not_found" ? `NOT_FOUND: ${t("notFoundMessage")}` : o.raw,
          );
          router.refresh();
        })
      }
    >
      {label}
    </button>
  );
  // Deactivate hides on purpose a click away from Open; Activate is safe, so it stays in view.
  return (
    <div className="flex flex-col items-end gap-1">
      {status === "active" ? (
        <div className="flex items-center gap-2">
          {open && toggle}
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("moreAria", { name })}
            className={`${secondaryButtonClass} min-h-9 px-3`}
            onClick={() => setOpen((o) => !o)}
          >
            {t("more")}
          </button>
        </div>
      ) : (
        toggle
      )}
      {error && (
        <p role="alert" className="max-w-64 text-right text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
