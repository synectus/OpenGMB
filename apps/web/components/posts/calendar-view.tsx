import { getTranslations } from "next-intl/server";
import type { postsCalendar } from "@opengmb/core";
import { posts_calendar } from "../../app/_generated/actions";
import { getTimeFormat } from "../../lib/time-format-server";
import { PostCalendar, calendarGrid } from "../post-calendar";
import { ErrorText } from "../ui";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export async function CalendarView({ ws, carry, narrow, month }: { ws?: string; carry?: string; narrow: { groupId?: string; locationIds?: string[] }; month?: string }) {
  const t = await getTranslations("posts");
  const tf = await getTimeFormat(carry);
  const g = calendarGrid(month, tf, ws);
  const r = await posts_calendar({
    from: g.start.toISOString(),
    to: g.end.toISOString(),
    workspaceId: ws,
    ...narrow,
  });
  if (!r.ok) return <ErrorText message={`${r.error.code}: ${r.error.message}`} />;
  const { entries, truncated } = r.data as Handler<typeof postsCalendar>;
  return (
    <PostCalendar t={t} month={g.month} ws={carry} workspaceId={ws} tf={tf} entries={entries} truncated={truncated} today={tf.today(ws)} />
  );
}
