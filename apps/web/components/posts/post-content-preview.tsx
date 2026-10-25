import type { PostView } from "../../lib/posts-lists";

/** The post as the writer made it: image (or a placeholder), text, offer code and terms, event. Shared by /approvals and the queue. */
export function PostContentPreview({ post }: { post: PostView }) {
  const image = post.media[0]?.sourceUrl;
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- https URL stored with the post, not optimised by next/image
        <img src={image} alt="" className="h-40 w-full object-cover" />
      ) : (
        <div
          role="img"
          aria-label="Post image placeholder"
          className="flex h-36 items-center justify-center bg-muted text-[13px] font-semibold text-muted-foreground"
        >
          No image attached
        </div>
      )}
      <div className="flex flex-col gap-1.5 p-3.5">
        <p className="m-0 whitespace-pre-wrap">{post.summary}</p>
        {post.offer?.couponCode ? (
          <span className="text-xs text-muted-foreground">
            Code {post.offer.couponCode}
            {post.offer.termsConditions ? ` · Terms: ${post.offer.termsConditions}` : ""}
          </span>
        ) : null}
        {post.event?.title ? (
          <span className="text-xs text-muted-foreground">
            {post.event.title}
            {post.event.startDate ? ` · ${post.event.startDate}` : ""}
            {post.event.endDate ? ` to ${post.event.endDate}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}
