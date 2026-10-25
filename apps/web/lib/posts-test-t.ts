import { createTranslator } from "next-intl";
import { PAGES } from "../messages/pages";
import type { T } from "./posts-lists";

/** The `posts` translator in English, for tests of the helpers that take `t`. */
export const tEn = createTranslator({
  locale: "en",
  messages: { posts: PAGES.posts.en },
  namespace: "posts",
}) as unknown as T;
