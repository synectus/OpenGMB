import { useTranslations } from "next-intl";
import { diffRows, structuredSides, type ChangeData } from "../../lib/changes";
import { describeChange, type ChangeLine } from "../../lib/describe-change";

type Translate = ReturnType<typeof useTranslations>;

/** One line as the Before and After cell text; null = nothing on that side. */
function lineText(l: ChangeLine, t: Translate): { before: string | null; after: string | null } {
  const flag = (v: boolean | null) => t(v === null ? "diff.empty" : v ? "diff.yes" : "diff.no");
  const val = (path: string, v: string | null) => (path ? `${path}: ${v ?? t("diff.empty")}` : (v ?? t("diff.empty")));
  switch (l.type) {
    case "addressShown":
      return {
        before: t("diff.addressShown", { value: flag(l.before) }),
        after: t("diff.addressShown", { value: flag(l.after) }),
      };
    case "placesAdded":
      return { before: null, after: t("diff.placesAdded", { names: l.names.join("; ") }) };
    case "placesRemoved":
      return { before: t("diff.placesRemoved", { names: l.names.join("; ") }), after: null };
    case "placesUnchanged": {
      const s = t("diff.placesUnchanged", { count: l.count });
      return { before: s, after: s };
    }
    case "key":
      return { before: val(l.path, l.before), after: val(l.path, l.after) };
  }
}

function Lines({ lines, side, t }: { lines: ChangeLine[]; side: "before" | "after"; t: Translate }) {
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((l, i) => (
        <li key={i}>{lineText(l, t)[side] ?? "-"}</li>
      ))}
    </ul>
  );
}

/** Field / Before / After, plain field names; structures summarised to what differs (canvas "6 · VALUES"). */
export function ChangeDiff({ change }: { change: Pick<ChangeData, "fieldPaths" | "before" | "after"> }) {
  const t = useTranslations("locationHub.changes");
  const rows = diffRows(change);
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t("field")}</th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t("before")}</th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold text-muted-foreground">{t("after")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const sides = structuredSides(change, change.fieldPaths[i]!);
            const lines = sides ? describeChange(change.fieldPaths[i]!, sides.before, sides.after) : [];
            return (
              <tr key={r.field} className="border-t border-border align-top">
                <td className="px-3 py-2 text-xs font-semibold">{r.field}</td>
                {lines.length > 0 ? (
                  <>
                    <td className="max-w-xs break-words px-3 py-2"><Lines lines={lines} side="before" t={t} /></td>
                    <td className="max-w-xs break-words px-3 py-2"><Lines lines={lines} side="after" t={t} /></td>
                  </>
                ) : (
                  <>
                    <td className={`max-w-xs break-words px-3 py-2 ${r.mono ? "font-mono text-xs" : ""}`}>{r.before}</td>
                    <td className={`max-w-xs break-words px-3 py-2 ${r.mono ? "font-mono text-xs" : ""}`}>{r.after}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
