import { POST_IMAGE_TEXT, type PostImageLayout } from "@opengmb/core/post-image-templates";

export type BrandedForm = {
  photoImageId: string | null;
  layout: PostImageLayout;
  headline: string;
  subline: string;
  useLogo: boolean;
};

export function initialForm(defaults: { hasLogo: boolean }, photoImageId: string | null): BrandedForm {
  return { photoImageId, layout: "band", headline: "", subline: "", useLogo: defaults.hasLogo };
}

/** A key under the `posts` messages for the first problem, or null when the form can be sent. */
export function formProblem(f: BrandedForm): string | null {
  if (!f.photoImageId) return "branded.problemNoPhoto";
  const headline = f.headline.trim();
  if (headline.length === 0) return "branded.problemNoHeadline";
  if (headline.length > POST_IMAGE_TEXT.headlineMax) return "branded.problemHeadlineLong";
  if (f.subline.trim().length > POST_IMAGE_TEXT.sublineMax) return "branded.problemSublineLong";
  return null;
}

export function toActionInput(f: BrandedForm, workspaceId: string) {
  if (!f.photoImageId) throw new Error("photoImageId is required");
  return {
    workspaceId,
    photoImageId: f.photoImageId,
    layout: f.layout,
    headline: f.headline,
    subline: f.subline,
    useLogo: f.useLogo,
  };
}
