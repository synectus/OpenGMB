import Link from "next/link";
import { EmptyState, linkClass } from "./ui";

/**
 * A view that works on one client, while the scope is All clients and there are several.
 * The links are ?ws= deep links (that page only); the switcher makes the choice stick.
 */
export function ChooseClient({
  title,
  text,
  path,
  workspaces,
}: {
  title: string;
  text: string;
  path: string;
  workspaces: { id: string; name: string }[];
}) {
  return (
    <EmptyState title={title}>
      <p>{text}</p>
      <ul className="mt-3 flex flex-col gap-1">
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link href={`${path}${path.includes("?") ? "&" : "?"}ws=${w.id}`} className={linkClass}>
              {w.name}
            </Link>
          </li>
        ))}
      </ul>
    </EmptyState>
  );
}
