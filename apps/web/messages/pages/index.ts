// Page-group namespaces (G8a). Add one import and one entry per file; keep the list sorted.
import agents from "./agents";
import aiCost from "./aiCost";
import aiVoice from "./aiVoice";
import approvals from "./approvals";
import assistant from "./assistant";
import audit from "./audit";
import authFlows from "./authFlows";
import geogrid from "./geogrid";
import geogridCost from "./geogridCost";
import home from "./home";
import liveStatus from "./liveStatus";
import locationHub from "./locationHub";
import locations from "./locations";
import notifications from "./notifications";
import performance from "./performance";
import posts from "./posts";
import profile from "./profile";
import reports from "./reports";
import reviews from "./reviews";
import reviewTopics from "./reviewTopics";
import reviewsTools from "./reviewsTools";
import scope from "./scope";
import settings from "./settings";
import settingsStatus from "./settingsStatus";
import settingsTeam from "./settingsTeam";
import settingsWebhooks from "./settingsWebhooks";
import { PRIVATE_PAGES } from "./private";
import twoFactor from "./twoFactor";
import workspaces from "./workspaces";

export const PAGES = {
  ...PRIVATE_PAGES,
  agents,
  aiCost,
  aiVoice,
  approvals,
  assistant,
  audit,
  authFlows,
  geogrid,
  geogridCost,
  home,
  liveStatus,
  locationHub,
  locations,
  notifications,
  performance,
  posts,
  profile,
  reports,
  reviews,
  reviewTopics,
  reviewsTools,
  scope,
  settings,
  settingsStatus,
  settingsTeam,
  settingsWebhooks,
  twoFactor,
  workspaces,
} as const;
