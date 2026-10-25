"use client";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { aiNotice_acknowledge, aiSwitch_get } from "../app/_generated/actions";
import { AI_NOTICE_FACTS } from "../lib/ai-notice";
import { buttonClass, secondaryButtonClass } from "./ui";

// Once this browser tab knows the person has seen the notice, it does not ask the server again.
let seenInThisTab = false;

/**
 * The one-time AI notice. Call `await ready()` first in any handler that sends content to an AI provider: it resolves
 * true at once when the person has already seen the notice (stored per person on the server), otherwise it shows the
 * notice in `dialog` and resolves true when they continue or false when they cancel.
 */
export function useAiNotice(): { ready: () => Promise<boolean>; dialog: ReactNode } {
  const t = useTranslations("common.aiNotice");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ready = useCallback(async () => {
    if (seenInThisTab) return true;
    const r = await aiSwitch_get({});
    // If the check itself fails, let the action run and report its own error.
    if (!r.ok || (r.data as { noticeSeen: boolean }).noticeSeen) {
      seenInThisTab = true;
      return true;
    }
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  async function finish(ok: boolean) {
    if (ok) {
      setPending(true);
      await aiNotice_acknowledge({});
      seenInThisTab = true;
      setPending(false);
    }
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  }

  const dialog = open ? (
    <div role="alertdialog" aria-labelledby="ai-notice-title" aria-describedby="ai-notice-body" className="flex flex-col gap-2 rounded-panel border border-input bg-card p-4 shadow-card" data-testid="ai-notice">
      <p id="ai-notice-title" className="text-sm font-semibold">
        {t("title")}
      </p>
      <p id="ai-notice-body" className="text-sm">
        {t("body", { days: AI_NOTICE_FACTS.retentionDays })}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={buttonClass} disabled={pending} onClick={() => void finish(true)}>
          {t("continue")}
        </button>
        <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void finish(false)}>
          {t("cancel")}
        </button>
      </div>
    </div>
  ) : null;

  return { ready, dialog };
}
