// The browser only receives the namespaces of the route it is on. A namespace belongs in a set when
// a component that runs in the browser calls useTranslations("<name>"); server components use
// getTranslations and need nothing. Each set is rendered by <ClientMessages set="..."> in a layout
// (or page) of the route; the app/ root layout sends none, so public pages carry no translation
// JSON they do not use. An inner NextIntlClientProvider REPLACES the outer messages, so every set
// lists the full list for its subtree (the shell's namespaces plus its own). lib/client-messages.test.ts
// walks the import graph of every route file and fails if a useTranslations namespace is missing
// from the set that route renders under, so a forgotten one fails in CI, not as raw keys on screen.

import { privateSets } from "./client-private";

// Rendered by the (app) layout: the sidebar, header, command palette, bell, scope switcher.
const SHELL = ["assistant", "common", "liveStatus", "nav", "notifications", "scope", "search", "shell"];
const app = (...more: string[]) => [...SHELL, ...more];

export const MESSAGE_SETS = {
  ...privateSets(app),
  // app/layout.tsx: pages that need no client messages (/privacy, /terms, /help, /status, /l/...).
  root: [],
  // Public flows
  authForm: ["auth", "common"], // /sign-in, /sign-up
  resetFlow: ["auth", "authFlows"], // /forgot-password, /reset-password
  mfa: ["auth", "authFlows"], // /mfa/setup, /mfa/verify
  invite: ["authFlows"], // /invite
  reportShare: ["reports"], // /r/[token]
  // Agency app
  app: SHELL,
  home: app("home", "settingsStatus", "workspaces"),
  account: app("account", "auth", "authFlows", "twoFactor"),
  agents: app("agents", "settingsTeam"),
  approvals: app("approvals", "reviews"),
  audit: app("audit"),
  geogrid: app("geogrid"), // StaffMessages adds the staff-only geogridCost on top of this set
  locations: app("locations"),
  locationsAlerts: app("approvals", "locationHub", "locations"),
  locationsBulkEdit: app("approvals", "locationHub", "locations", "posts", "profile", "reviews"),
  locationsHealth: app("locationHub", "locations"),
  locationHub: app("approvals", "locationHub", "locations"), // /locations/[id]
  locationChanges: app("approvals", "locationHub", "posts", "reviews"),
  locationHealth: app("locationHub"),
  locationMedia: app("locationHub", "posts", "reviews"),
  locationProfile: app("approvals", "common", "locationHub", "posts", "profile", "reviews"),
  performance: app("performance"),
  posts: app("approvals", "posts", "reviews"),
  reports: app("reports"),
  reviews: app("agents", "reviews", "reviewTopics", "reviewsTools"),
  settings: app("settings"),
  settingsStatus: app("settingsStatus"),
  settingsTeam: app("settingsTeam"),
  settingsWebhooks: app("settingsWebhooks"),
  settingsWorkspace: app("aiVoice", "approvals", "settings"),
  workspaces: app("settings", "workspaces"),
} satisfies Record<string, string[]>;

export type MessageSet = keyof typeof MESSAGE_SETS;

/** Every namespace any route sends. */
export const CLIENT_NAMESPACES = [...new Set(Object.values(MESSAGE_SETS).flat())].sort();

/** The listed namespaces of `all`. A name `all` lacks throws, so a typo fails the page, not silently. */
export function pickMessages<M extends Record<string, unknown>>(all: M, names: readonly string[]): Partial<M> {
  return Object.fromEntries(
    names.map((k) => {
      if (!(k in all)) throw new Error(`messages: unknown namespace "${k}"`);
      return [k, all[k]];
    }),
  ) as Partial<M>;
}
