import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { notifications } from "@opengmb/db";
import { defineAction } from "../registry";

const itemOut = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  link: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

export const notificationsList = defineAction({
  name: "notifications.list",
  description:
    "List the caller's own in-app notifications, newest first, with the total unreadCount. Only the caller's notifications in their organization are ever returned. Titles name the location, never review text.",
  input: z.object({
    unreadOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: z.object({ unreadCount: z.number().int(), items: z.array(itemOut) }),
  permission: "notification:own",
  kind: "read",
  async handler({ tx, actor }, input) {
    const mine = and(eq(notifications.userId, actor.userId), eq(notifications.orgId, actor.orgId));
    const [unread] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(and(mine, isNull(notifications.readAt)));
    const rows = await tx
      .select()
      .from(notifications)
      .where(input.unreadOnly ? and(mine, isNull(notifications.readAt)) : mine)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(input.limit);
    return {
      unreadCount: unread?.n ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        link: r.link,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })),
    };
  },
});

export const notificationsMarkRead = defineAction({
  name: "notifications.markRead",
  description:
    "Mark the caller's own notifications as read: pass ids (1-100 notification ids) or all: true. Ids that belong to someone else or do not exist are silently ignored; updated counts only notifications that were unread and the caller's.",
  input: z
    .object({
      ids: z.array(z.uuid()).min(1).max(100).optional(),
      all: z.boolean().optional(),
    })
    .refine((v) => (v.ids !== undefined) !== (v.all === true), {
      message: "Pass either ids or all: true, not both and not neither",
    }),
  output: z.object({ updated: z.number().int() }),
  permission: "notification:own",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const updated = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, actor.userId),
          eq(notifications.orgId, actor.orgId),
          isNull(notifications.readAt),
          input.ids ? inArray(notifications.id, input.ids) : undefined,
        ),
      )
      .returning({ id: notifications.id });
    await audit({
      action: "notification.mark_read",
      entityType: "user_notifications",
      entityId: actor.userId,
      before: null,
      after: { count: updated.length, ids: input.ids ? updated.map((r) => r.id) : "all" },
    });
    return { updated: updated.length };
  },
});
