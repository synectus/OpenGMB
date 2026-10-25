import Link from "next/link";
import { Zap } from "lucide-react";

const chip =
  "inline-flex h-8 items-center gap-2 rounded-full border border-warn-border bg-warn-bg px-3 text-[13px] font-semibold text-warn";

/**
 * "Auto-approve 5★ is on in N workspaces". A link on /approvals and /reviews (never a button: the
 * smoke test counts buttons named "approve" on /reviews), a plain span in the Reply settings preview.
 */
export function AutoApproveChipView({ text, href }: { text: string; href?: string }) {
  const body = (
    <>
      <Zap aria-hidden className="size-3.5" />
      {text}
    </>
  );
  if (!href) return <span className={chip}>{body}</span>;
  return (
    <Link
      href={href}
      className={`${chip} hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      {body}
    </Link>
  );
}
