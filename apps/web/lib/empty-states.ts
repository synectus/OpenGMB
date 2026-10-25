// The "nothing here yet" state of each page that can be empty (roadmap U10). One place, so a page can
// never ship an empty state with no next step: lib/empty-states.test.ts reads this registry, checks
// each entry, and checks that the page renders it through <EmptyNext id>.
export type EmptyEntry = {
  /** Route under app/(app), used to find the page. */
  route: string;
  /** Source file (relative to apps/web) that renders <EmptyNext id="...">. */
  file: string;
  title: string;
  /** Plain words: what to do next. */
  next: string;
  /** The one link or button. A page may pass a more specific href (a chosen client or location). */
  cta: { label: string; href: string };
};

export const EMPTY_STATES = {
  reviews: {
    route: "/reviews",
    file: "app/(app)/reviews/page.tsx",
    title: "No reviews yet",
    next: "Reviews arrive from Google when a client syncs. Press Sync now at the top of the page, or check that Google is still connected.",
    cta: { label: "Google connection", href: "/settings/google" },
  },
  posts: {
    route: "/posts",
    file: "components/posts/list-view.tsx",
    title: "No posts yet",
    next: "Write your first post, or connect your agent and let it draft one for you to check.",
    cta: { label: "New post", href: "/posts?view=compose" },
  },
  approvals: {
    route: "/approvals",
    file: "app/(app)/approvals/page.tsx",
    title: "Nothing needs approval right now",
    next: "Replies, posts and profile changes land here when someone submits them. Start with a review that needs a reply.",
    cta: { label: "Open Reviews", href: "/reviews" },
  },
  locations: {
    route: "/locations",
    file: "app/(app)/locations/page.tsx",
    title: "No locations yet",
    next: "Import them from a connected Google account. Each one gets reviews, a health score and a profile here.",
    cta: { label: "Import from Google", href: "/locations/import" },
  },
  performance: {
    route: "/performance",
    file: "app/(app)/performance/page.tsx",
    title: "No data for this range yet",
    next: "Pick a longer range, or fetch calls, directions and searches from Google for one location.",
    cta: { label: "Show the last 90 days", href: "/performance" },
  },
  reports: {
    route: "/reports",
    file: "app/(app)/reports/page.tsx",
    title: "No reports yet",
    next: "Pick a report type to create your first one. It can be emailed or shared as a link.",
    cta: { label: "New report", href: "/reports/new?type=performance" },
  },
  alerts: {
    route: "/locations/alerts",
    file: "app/(app)/locations/alerts/page.tsx",
    title: "No profile changes found",
    next: "OpenGMB compares each profile with Google every night at 03:30 UTC. Until something changes, check how complete your profiles are.",
    cta: { label: "Open location health", href: "/locations/health" },
  },
  changes: {
    route: "/locations/[id]/changes",
    file: "app/(app)/locations/[id]/changes/page.tsx",
    title: "No profile changes found yet",
    next: "The first nightly check is a baseline and raises nothing. Until a change shows up, check how complete this profile is.",
    cta: { label: "Open location health", href: "/locations/health" },
  },
  "rank-tracking": {
    route: "/geogrid",
    file: "components/rank-tracking/trackers-view.tsx",
    title: "No rank trackers yet",
    next: "A tracker checks where a location ranks for a keyword on a map grid. Create one, then run it.",
    cta: { label: "New tracker", href: "/geogrid?view=new" },
  },
  audit: {
    route: "/audit",
    file: "app/(app)/audit/page.tsx",
    title: "No audit entries yet",
    next: "Every action from the app, an API token or the worker is recorded here. Reply to a review or create a post and the first entry appears.",
    cta: { label: "Open Reviews", href: "/reviews" },
  },
  photos: {
    route: "/locations/[id]/media",
    file: "components/media-manager.tsx",
    title: "No photos yet",
    next: "Add a cover, a logo and a few real photos of the place. Profiles with photos get more calls and directions.",
    cta: { label: "Add a photo", href: "#add-photo" },
  },
} as const satisfies Record<string, EmptyEntry>;

export type EmptyId = keyof typeof EMPTY_STATES;
