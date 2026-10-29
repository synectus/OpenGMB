"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  locationGroups_create,
  locationGroups_delete,
  locationGroups_rename,
  locationGroups_setMembers,
} from "../../app/_generated/actions";
import { locationLabel } from "../../lib/locations";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

type Loc = { id: string; name: string; addressSummary?: string | null; phone?: string | null };
type Group = { id: string; name: string; locationIds: string[] };
type Call = (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) => Promise<boolean>;

const destructiveClass =
  "inline-flex min-h-(--control-h) items-center rounded-control border border-bad-border bg-bad-bg px-4 text-sm font-semibold text-bad hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function GroupsPanel({
  workspaceId,
  groups,
  locations,
}: {
  workspaceId: string;
  groups: Group[];
  locations: Loc[];
}) {
  const t = useTranslations("locations");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");

  const call: Call = async (fn) => {
    setError(null);
    const r = await fn();
    if (!r.ok && r.error) setError(`${r.error.code}: ${r.error.message}`);
    router.refresh();
    return r.ok;
  };

  const summary = (memberIds: string[]) => {
    const names = locations.filter((l) => memberIds.includes(l.id)).map((l) => l.name);
    return names.length === 0 ? t("groupSummaryNone") : t("groupSummary", { count: names.length, names: names.join(", ") });
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorText message={error} />
      {groups.length === 0 && <p className="text-sm text-muted-foreground">{t("noGroupsYet")}</p>}
      {groups.map((g) =>
        editing === g.id ? (
          <GroupEditor key={g.id} group={g} locations={locations} call={call} onDone={() => setEditing(null)} />
        ) : (
          <div key={g.id} className="flex items-center justify-between gap-3 rounded-control border border-border p-3">
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold text-foreground">{g.name}</span>
              <span className="truncate text-sm text-muted-foreground">{summary(g.locationIds)}</span>
            </div>
            <button type="button" className={`${secondaryButtonClass} min-h-9`} aria-label={t("editAria", { name: g.name })} onClick={() => setEditing(g.id)}>
              {t("edit")}
            </button>
          </div>
        ),
      )}
      <form
        className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call(() => locationGroups_create({ workspaceId, name: newGroup }))) setNewGroup("");
        }}
      >
        <label className="flex flex-1 flex-col gap-1 text-sm font-semibold text-foreground">
          {t("newGroupName")}
          <input
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            maxLength={100}
            required
            placeholder={t("groupNamePlaceholder")}
            className={inputClass}
          />
        </label>
        <button type="submit" className={buttonClass}>
          {t("createGroup")}
        </button>
      </form>
    </div>
  );
}

function GroupEditor({
  group,
  locations,
  call,
  onDone,
}: {
  group: Group;
  locations: Loc[];
  call: Call;
  onDone: () => void;
}) {
  const t = useTranslations("locations");
  const [selected, setSelected] = useState(new Set(group.locationIds));
  const [name, setName] = useState(group.name);
  return (
    <div className="flex flex-col gap-3 rounded-control border border-brand bg-brand-tint p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm font-semibold text-foreground">
          {t("groupName")}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className={inputClass} />
        </label>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={name.trim() === "" || name === group.name}
          onClick={() => call(() => locationGroups_rename({ groupId: group.id, name }))}
        >
          {t("rename")}
        </button>
        <button
          type="button"
          className={destructiveClass}
          onClick={async () => {
            if (window.confirm(t("confirmDeleteGroup", { name: group.name }))) {
              if (await call(() => locationGroups_delete({ groupId: group.id }))) onDone();
            }
          }}
        >
          {t("delete")}
        </button>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold text-foreground">{t("membersOf", { name: group.name })}</legend>
        <div className="flex flex-wrap gap-2">
          {locations.map((l) => {
            const on = selected.has(l.id);
            return (
              <label
                key={l.id}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${on ? "border-brand bg-card font-semibold" : "border-border bg-card"}`}
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={on}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(l.id);
                    else next.delete(l.id);
                    setSelected(next);
                  }}
                />
                {locationLabel(l)}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={buttonClass}
          onClick={async () => {
            if (await call(() => locationGroups_setMembers({ groupId: group.id, locationIds: [...selected] }))) onDone();
          }}
        >
          {t("saveMembers")}
        </button>
        <span className="text-xs text-muted-foreground">{t("deleteNote")}</span>
      </div>
    </div>
  );
}
