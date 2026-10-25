"use client";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type InputHTMLAttributes } from "react";
import { inputClass } from "./ui";

/**
 * A password input with a show/hide toggle. The toggle's accessible name is "Show characters" and
 * never contains "Password": the smoke test's getByLabel("Password") matches substrings, including
 * aria-labels (spec §3). The toggle sits outside the <label>, and aria-pressed carries its state.
 */
export function PasswordField({
  label,
  id,
  ...props
}: { label: string; id: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const t = useTranslations("auth");
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={shown ? "text" : "password"}
          className={`${inputClass} w-full pr-11`}
          {...props}
        />
        <button
          type="button"
          aria-label={t("showCharacters")}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
          className="absolute inset-y-0 right-1 my-auto flex size-9 items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
        >
          {shown ? (
            <EyeOff aria-hidden className="size-[18px]" />
          ) : (
            <Eye aria-hidden className="size-[18px]" />
          )}
        </button>
      </div>
    </div>
  );
}
