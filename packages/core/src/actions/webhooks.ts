import { z } from "zod";
import { defineAction } from "../registry";
import { WEBHOOK_EVENTS } from "../config/webhooks";
import {
  checkWebhookUrl,
  listWebhookDeliveries,
  listWebhooks,
  queueTestWebhook,
  setWebhookStatus,
  subscribeWebhook,
  unsubscribeWebhook,
} from "../webhooks/subscriptions";

const subscriptionOut = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  workspaceId: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.string(),
  lastDelivery: z
    .object({
      status: z.string(),
      statusCode: z.number().int().nullable(),
      at: z.string(),
      test: z.boolean(),
    })
    .nullable(),
});

export const webhooksList = defineAction({
  name: "webhooks.list",
  description:
    "List the organization's outgoing webhooks (owners and admins only), newest first, each with its status, why it was turned off if it was, and its most recent delivery. Never returns signing secrets.",
  input: z.object({}),
  output: z.object({ webhooks: z.array(subscriptionOut) }),
  permission: "webhook:manage",
  kind: "read",
  async handler({ tx, actor }) {
    return { webhooks: await listWebhooks(tx, actor) };
  },
});

export const webhooksSubscribe = defineAction({
  name: "webhooks.subscribe",
  description:
    'Create an outgoing webhook that POSTs a signed JSON event to an https URL (port 443, public hosts only) when a new review arrives (event "review.created"). Owners and admins only; an API token needs the write scope. Executes directly (no proposal step); dryRun previews and checks the URL. The signing secret (starts "whsec_") is returned once and cannot be recovered: store it now. Optional workspaceId limits it to one client. At most 10 active webhooks per organization.',
  input: z.object({
    url: z.string().trim().min(1).max(2000),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
    workspaceId: z.uuid().optional(),
    description: z.string().trim().min(1).max(200).optional(),
  }),
  output: z.object({ subscription: subscriptionOut, secret: z.string() }),
  permission: "webhook:manage",
  kind: "write",
  // Direct (decision D1): a REST Hook subscribe cannot apply a proposal. The permission, the write
  // scope, the audit row and the visible-and-deletable list in Settings are the gate.
  approval: "own_flow",
  async preview(_ctx, input) {
    const url = await checkWebhookUrl(input.url);
    return {
      summary: `Would send a signed "review.created" event to ${url.host} for ${input.workspaceId ? "one client" : "every client"}. The signing secret is shown once, on apply.`,
      diff: { before: null, after: { host: url.host, events: input.events ?? [...WEBHOOK_EVENTS] } },
    };
  },
  async handler({ tx, actor, audit }, input) {
    return subscribeWebhook(tx, actor, input, audit);
  },
});

export const webhooksUnsubscribe = defineAction({
  name: "webhooks.unsubscribe",
  description:
    "Delete an outgoing webhook by id, with its delivery history. Owners and admins only. Executes directly; dryRun previews.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  permission: "webhook:manage",
  kind: "write",
  approval: "own_flow",
  async preview(_ctx, input) {
    return {
      summary: `Would delete webhook ${input.id} and its delivery history.`,
      diff: { before: { id: input.id }, after: null },
    };
  },
  async handler({ tx, actor, audit }, input) {
    return unsubscribeWebhook(tx, actor, input.id, audit);
  },
});

export const webhooksSetStatus = defineAction({
  name: "webhooks.setStatus",
  description:
    'Turn an outgoing webhook "active" or "disabled" by id. Turning it on again clears its failure count. Owners and admins only. At most 10 webhooks can be active.',
  input: z.object({ id: z.uuid(), status: z.enum(["active", "disabled"]) }),
  output: z.object({ webhook: subscriptionOut }),
  permission: "webhook:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    return { webhook: await setWebhookStatus(tx, actor, input, audit) };
  },
});

export const webhooksDeliveries = defineAction({
  name: "webhooks.deliveries",
  description:
    "List the last 50 deliveries of one outgoing webhook, newest first: status, HTTP status code, attempts and times. Never returns the payload or the signing secret. Deliveries are kept for 30 days.",
  input: z.object({ id: z.uuid() }),
  output: z.object({
    deliveries: z.array(
      z.object({
        id: z.string(),
        eventType: z.string(),
        test: z.boolean(),
        status: z.enum(["pending", "delivered", "failed", "skipped"]),
        attempts: z.number().int(),
        lastStatusCode: z.number().int().nullable(),
        lastError: z.string().nullable(),
        createdAt: z.string(),
        deliveredAt: z.string().nullable(),
      }),
    ),
  }),
  permission: "webhook:manage",
  kind: "read",
  async handler({ tx, actor }, input) {
    return { deliveries: await listWebhookDeliveries(tx, actor, input.id) };
  },
});

export const webhooksSendTest = defineAction({
  name: "webhooks.sendTest",
  description:
    'Queue one sample "review.created" event (marked test: true) to an active outgoing webhook, signed like a real one. Owners and admins only. Executes directly; check the result with webhooks.deliveries.',
  input: z.object({ id: z.uuid() }),
  output: z.object({ deliveryId: z.string() }),
  permission: "webhook:manage",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    return queueTestWebhook(tx, actor, input.id, audit);
  },
});
