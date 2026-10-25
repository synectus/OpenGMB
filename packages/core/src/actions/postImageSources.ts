import { useAccountDaily } from "../limits/counters";
import { z } from "zod";
import { AI_IMAGES, STOCK_PHOTOS } from "../config/post-image-sources";
import { CoreError } from "../errors";
import { billingMode } from "../billing";
import { aiEnv } from "../ai/model";
import { aiImageChargeMicroUsd, runImageGeneration } from "../postImages/aiImageSpend";
import {
  AI_IMAGES_NOT_SET_UP,
  STOCK_NOT_SET_UP,
  aiImageKey,
  fetchStockPhoto,
  searchStock,
  stockSearchCached,
  stockKey,
} from "../postImages/providers";
import { createPostImageTx, publicPostImageUrl, requireWorkspace } from "../postImages/store";
import { defineAction } from "../registry";

const imageRef = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  byteSize: z.number().int(),
  contentType: z.string(),
});
type Row = Awaited<ReturnType<typeof createPostImageTx>>;
const refOf = (row: Row) => ({
  id: row.id,
  url: publicPostImageUrl(row.token),
  name: row.name,
  width: row.width,
  height: row.height,
  byteSize: row.byteSize,
  contentType: row.contentType,
});

export const postImagesSources = defineAction({
  name: "postImages.sources",
  description:
    "Which image sources are set up on this server for post images, and what an AI image costs. stock.available: free stock photo search (Pixabay) has a key. ai.available: AI image generation has a key. ai.chargeMicroUsd is what the account is charged for one AI image (micro-USD, 1,000,000 = 1 USD; cost plus markup), shown before generating; ai.charged is false when this server does not bill. Needs review:read.",
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({
    stock: z.object({ available: z.boolean(), provider: z.string(), attribution: z.string() }),
    ai: z.object({
      available: z.boolean(),
      chargeMicroUsd: z.number().int(),
      charged: z.boolean(),
      size: z.string(),
      label: z.string(),
    }),
  }),
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:read");
    return {
      stock: { available: stockKey() !== null, provider: STOCK_PHOTOS.label, attribution: STOCK_PHOTOS.attribution },
      ai: {
        available: aiImageKey() !== null,
        chargeMicroUsd: aiImageChargeMicroUsd(),
        charged: billingMode(aiEnv()) === "hosted",
        size: AI_IMAGES.size,
        label: AI_IMAGES.label,
      },
    };
  },
});

export const postImagesSearchStock = defineAction({
  name: "postImages.searchStock",
  description: `Search free stock photos (${STOCK_PHOTOS.label}) for a post image. Free: nothing is charged and nothing is saved. Returns up to ${STOCK_PHOTOS.perPage} landscape photos per page with a thumbnail and the photographer's attribution. Pass a result's id to postImages.addStock to save it to the library. NOT_CONFIGURED when this server has no stock photo key. Needs review:draft.`,
  input: z.object({
    workspaceId: z.uuid(),
    query: z.string().trim().min(1).max(STOCK_PHOTOS.queryMaxChars),
    page: z.number().int().min(1).max(50).default(1),
  }),
  output: z.object({
    results: z.array(
      z.object({
        id: z.string(),
        thumbUrl: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        alt: z.string(),
        creditName: z.string(),
        creditUrl: z.string(),
      }),
    ),
    hasMore: z.boolean(),
  }),
  permission: "review:draft",
  kind: "read",
  async handler({ tx, actor }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:draft");
    if (!stockKey()) throw new CoreError("NOT_CONFIGURED", STOCK_NOT_SET_UP);
    if (!stockSearchCached(input.query, input.page)) await useAccountDaily(tx, actor.orgId, "stock_search", 1);
    return searchStock(input.query, input.page);
  },
});

export const postImagesAddStock = defineAction({
  name: "postImages.addStock",
  description:
    "Save one stock photo (an id from postImages.searchStock) to the client's post image library, with the photographer's attribution stored on the image. Free. The server fetches the photo and its attribution from the provider itself; only the id is taken from the caller. Returns the image: put its url in a post's media sourceUrl. Needs review:draft.",
  input: z.object({ workspaceId: z.uuid(), stockPhoto: z.string().trim().min(1).max(20) }),
  output: z.object({ image: imageRef.extend({ creditName: z.string(), creditUrl: z.string() }) }),
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:draft");
    if (!stockKey()) throw new CoreError("NOT_CONFIGURED", STOCK_NOT_SET_UP);
    if (!/^\d{1,12}$/.test(input.stockPhoto)) throw new CoreError("INVALID_INPUT", "Not a stock photo id");
    const { photo, bytes } = await fetchStockPhoto(input.stockPhoto);
    const row = await createPostImageTx(tx, actor, audit, {
      workspaceId: input.workspaceId,
      filename: `Stock ${photo.alt || photo.id}`.slice(0, 80),
      bytes,
      origin: { source: "stock", creditName: photo.creditName, creditUrl: photo.creditUrl },
    });
    await audit({
      action: "post_image.stock_added",
      entityType: "post_image",
      entityId: row.id,
      after: { workspaceId: input.workspaceId, provider: STOCK_PHOTOS.provider, providerPhotoId: photo.id },
    });
    return { image: { ...refOf(row), creditName: photo.creditName, creditUrl: photo.creditUrl } };
  },
});

export const postImagesGenerate = defineAction({
  name: "postImages.generate",
  description: `Make an AI image for a post and save it to the client's post image library, flagged as AI-made. Any charge is the same as for an AI draft (see postImages.sources for the price, shown to the person before they confirm); also counts against the monthly AI limits. The picture is an illustration by design (a style guard is added to every prompt) because Google expects real photos of the business: the image must not be presented as a photo of the premises or staff. subject: what to show, up to ${AI_IMAGES.promptMaxChars} characters. NOT_CONFIGURED when this server has no AI image key; AI_BUDGET_EXCEEDED over a limit, or an error when the account cannot cover a charge. Needs review:draft. From an agent this is a proposal a person applies.`,
  input: z.object({ workspaceId: z.uuid(), subject: z.string().trim().min(3).max(AI_IMAGES.promptMaxChars) }),
  output: z.object({
    image: imageRef.extend({ aiGenerated: z.literal(true) }),
    chargedMicroUsd: z.number().int(),
  }),
  permission: "review:draft",
  kind: "write",
  async preview({ actor, readTx }, input) {
    await readTx((tx) => requireWorkspace(tx, actor, input.workspaceId, "review:draft"));
    return { summary: `Make an AI image for a post. Cost: ${(aiImageChargeMicroUsd() / 1_000_000).toFixed(3)} USD.` };
  },
  async handler({ tx, actor, audit }, input) {
    await requireWorkspace(tx, actor, input.workspaceId, "review:draft");
    if (!aiImageKey()) throw new CoreError("NOT_CONFIGURED", AI_IMAGES_NOT_SET_UP);
    const run = await runImageGeneration(tx, actor, input.workspaceId, input.subject);
    const row = await createPostImageTx(tx, actor, audit, {
      workspaceId: input.workspaceId,
      filename: `AI image ${input.subject}`.slice(0, 80),
      bytes: run.image.bytes,
      origin: { source: "ai" },
    });
    // The subject is post text and never goes in the audit log.
    await audit({
      action: "post_image.generated",
      entityType: "post_image",
      entityId: row.id,
      after: {
        workspaceId: input.workspaceId,
        model: AI_IMAGES.model,
        subjectChars: input.subject.length,
        costMicroUsd: run.costMicroUsd,
        chargedMicroUsd: run.chargedMicroUsd,
        usageId: run.usageId,
      },
    });
    return { image: { ...refOf(row), aiGenerated: true as const }, chargedMicroUsd: run.chargedMicroUsd };
  },
});
