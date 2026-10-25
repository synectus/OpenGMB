"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { secondaryButtonClass } from "../ui";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations("agents");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={secondaryButtonClass}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? t("copied") : label}
    </button>
  );
}
