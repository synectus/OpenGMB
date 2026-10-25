/** P7 branded post images. Our product choices unless a sourceUrl says otherwise. */
export const POST_IMAGE_SIZE = {
  width: 1200,
  height: 900,
  // Google's posts help page (answer/7342169) is script-rendered and names no post image size, so
  // this is our choice; it is inside MEDIA_LIMITS.photo.
  note: "our choice; inside MEDIA_LIMITS.photo",
  sourceUrl: "https://support.google.com/business/answer/6103862",
  verifiedOn: "2026-10-23",
} as const;
export const POST_IMAGE_LAYOUTS = ["band", "frame"] as const;
export type PostImageLayout = (typeof POST_IMAGE_LAYOUTS)[number];
export const POST_IMAGE_TEXT = {
  headlineMax: 80,
  sublineMax: 120,
  headlinePx: { max: 64, min: 44, step: 2 },
  sublinePx: 32,
  headlineMaxLines: 2,
  gapPx: 12,
  lineHeight: 1.15,
  bottomMarginPx: 36,
} as const;
// Per layout: text box and how many subline lines fit (frame's box is narrow, so its subline is 1 line).
export const POST_IMAGE_TEXT_BOX = {
  band: { x: 60, top: 664, width: 1080, sublineMaxLines: 2, ruleBelowHeadlinePx: 0 },
  frame: { x: 60, top: 676, width: 800, sublineMaxLines: 1, ruleBelowHeadlinePx: 16 },
} as const;
/** Decision 2026-10-23: white band and frame, near-black text. Not branding, not caller input. */
export const POST_IMAGE_COLORS = { surface: "#FFFFFF", text: "#111111" } as const;
export const POST_IMAGE_JPEG = {
  quality: 88,
  chromaSubsampling: "4:2:0",
  mozjpeg: false,
  progressive: false,
} as const;
export const POST_IMAGE_FONTS = {
  bold: {
    file: "Inter-Bold.ttf",
    sha256: "288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f",
  },
  regular: {
    file: "Inter-Regular.ttf",
    sha256: "40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82",
  },
  sourceUrl: "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip",
  licence: "SIL OFL 1.1",
  verifiedOn: "2026-10-23",
} as const;
