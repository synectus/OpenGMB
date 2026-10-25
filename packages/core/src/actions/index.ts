import type { AnyAction } from "../registry";
import { aiClientCapSet, aiDraftText, aiUsageGet, aiVoiceGet, aiVoiceUpdate } from "./ai";
import { aiDraftReplies, aiDraftReply } from "./aiReplies";
import { aiDraftBusinessDescription, aiDraftServiceDescription } from "./aiDescriptions";
import { aiDraftPost, aiDraftPostVariants, aiPostIdeas } from "./aiPosts";
export { apiTokensCreate, apiTokensCurrent, apiTokensList, apiTokensRevoke } from "./apiTokens";
export {
  webhooksDeliveries,
  webhooksList,
  webhooksSendTest,
  webhooksSetStatus,
  webhooksSubscribe,
  webhooksUnsubscribe,
} from "./webhooks";
export { auditExport, auditList, auditVerify } from "./audit";
export {
  googleConnectionsConnect,
  googleConnectionsConnectSample,
  googleConnectionsDisconnect,
  googleConnectionsList,
} from "./googleConnections";
export {
  locationGroupsCreate,
  locationGroupsDelete,
  locationGroupsList,
  locationGroupsRename,
  locationGroupsSetMembers,
} from "./locationGroups";
export {
  locationsImport,
  locationsImportStatus,
  locationsList,
  locationsListAvailable,
  locationsSetStatus,
  locationsStats,
} from "./locations";
export { notificationsList, notificationsMarkRead } from "./notifications";
export { reviewsAnalytics } from "./reviewAnalytics";
export { reviewsCompetitorBenchmark } from "./reviewBenchmark";
export {
  reviewNotesAdd,
  reviewNotesList,
  reviewsAssign,
  reviewsAssignees,
  reviewsAssignments,
} from "./reviewAssign";
export { reviewLinksGet, reviewLinksSave } from "./reviewLinks";
export {
  reviewRequestsCreate,
  reviewRequestsUpdate,
  reviewRequestsAddRecipients,
  reviewRequestsImportCsv,
  reviewRequestsStart,
  reviewRequestsCancel,
  reviewRequestsList,
  reviewRequestsGet,
  reviewRequestsRecipients,
} from "./reviewRequests";
export { locationPagesGet, locationPagesSet } from "./locationPages";
export { citationsAddCustom, citationsCheck, citationsCheckAll, citationsDeleteCustom, citationsList, citationsSave } from "./citations";
export {
  reviewsExport,
  reviewsGet,
  reviewsList,
  reviewsListUnreplied,
  reviewsSync,
  reviewsSyncStatus,
} from "./reviews";
export {
  reviewRepliesApprove,
  reviewRepliesCheck,
  reviewRepliesCreateDraft,
  reviewRepliesDeletePublished,
  reviewRepliesList,
  reviewRepliesListQueue,
  reviewRepliesPublish,
  reviewRepliesReject,
  reviewRepliesSubmit,
  reviewRepliesUpdateDraft,
} from "./reviewReplies";
export {
  replyTemplatesCreate,
  replyTemplatesDelete,
  replyTemplatesList,
  replyTemplatesRender,
  replyTemplatesUpdate,
} from "./replyTemplates";
export {
  postsApprove,
  postsCalendar,
  postsCancel,
  postsCheck,
  postsCreateDraft,
  postsDeletePublished,
  postsGet,
  postsList,
  postsGoogleList,
  postsSyncGoogle,
  postsReject,
  postsSchedule,
  postsSubmit,
  postsUpdateDraft,
} from "./posts";
export {
  postsApproveEdit,
  postsCancelEdit,
  postsEditGet,
  postsProposeEdit,
  postsRejectEdit,
} from "./postEdits";
export { profileAutoRevertGet, profileAutoRevertSet } from "./profileAutoRevert";
export {
  profileChangesAccept,
  profileChangesDismiss,
  profileChangesList,
  profileChangesRevert,
} from "./profileChanges";
export {
  locationsHealthcheck,
  locationsHealthcheckSkip,
  locationsHealthcheckSummary,
} from "./healthcheck";
export { locationsOverview } from "./locationOverview";
export { locationsCenterClearManual, locationsCenterGet, locationsCenterSet } from "./locationCenter";
export { postImagesDelete, postImagesList, postImagesRename, postImagesRenderBranded } from "./postImages";
export { postImagesAddStock, postImagesGenerate, postImagesSearchStock, postImagesSources } from "./postImageSources";
export { postsBulkCreateDrafts, postsBulkPreview } from "./postsBulk";
export {
  postTemplatesCreate,
  postTemplatesDelete,
  postTemplatesGet,
  postTemplatesList,
  postTemplatesUpdate,
} from "./postTemplates";
export { mediaAdd, mediaCustomerList, mediaDelete, mediaList, mediaUpload, mediaUploadMany, mediaBatch, mediaCancelScheduled } from "./media";
export {
  placeActionsCreate,
  placeActionsDelete,
  placeActionsList,
  placeActionsUpdate,
} from "./placeActions";
export {
  suspensionCasesCreate,
  suspensionCasesList,
  suspensionCasesUpdate,
  verificationState,
} from "./verification";
export { workspaceSettingsGet, workspaceSettingsUpdate } from "./workspaceSettings";
export {
  workspacesCreate,
  workspacesDelete,
  workspacesList,
  workspacesRename,
  workspacesSetPostLanguage,
  workspacesSetSenderIdentity,
  workspacesSetHipaa,
  workspacesSetTimeSettings,
} from "./workspaces";
export { workspacesEraseData, workspacesExportData } from "./privacy";
export {
  geogridCompetitors,
  geogridCompetitorChanges,
  geogridCompetitorProfiles,
  geogridConfigsCreate,
  geogridLocationCenter,
  geogridConfigsDelete,
  geogridConfigsList,
  geogridConfigsUpdate,
  geogridPreview,
  geogridRun,
  geogridQuickScansCreate,
  geogridRunsGet,
  geogridRunsList,
  geogridSettingsGet,
  geogridSettingsUpdate,
} from "./geogrid";
export { aiVisibilityGet, aiVisibilityRunNow, aiVisibilityUpdate } from "./aiVisibility";
export { rankingsList, rankingsSetFavorite, rankingsTrack, rankingsUntrack } from "./rankings";
export {
  geogridByoKeyDelete,
  geogridByoKeyGet,
  geogridByoKeySet,
  geogridByoKeyVerify,
  geogridUsage,
} from "./geogridByoKey";
import { apiTokensCreate, apiTokensCurrent, apiTokensList, apiTokensRevoke } from "./apiTokens";
import {
  webhooksDeliveries,
  webhooksList,
  webhooksSendTest,
  webhooksSetStatus,
  webhooksSubscribe,
  webhooksUnsubscribe,
} from "./webhooks";
import { brandingGet, brandingLogos, brandingRemoveLogo, brandingUpdate, storageUsage } from "./branding";
import { googleNotificationsRegisterAll, googleNotificationsStatus } from "./googleNotifications";
import { membersList, membersRemove, membersResetTwoFactor } from "./members";
import { approvalsCounts, approvalsQueue } from "./approvals";
import { attentionCounts, attentionQueue } from "./attention";
import { aiNoticeAcknowledge, aiSwitchGet, aiSwitchUpdate } from "./aiSwitch";
import { onboardingGet, onboardingUpdate } from "./onboarding";
import { mcpProposalsApply, mcpProposalsCancel, mcpProposalsList } from "./mcpProposals";
import { monitoringOverview } from "./monitoring";
import { systemStatus } from "./system";
import { searchEverything } from "./search";
import { workspacesEraseData, workspacesExportData } from "./privacy";
import { auditExport, auditList, auditVerify } from "./audit";
import {
  googleConnectionsConnect,
  googleConnectionsConnectSample,
  googleConnectionsDisconnect,
  googleConnectionsList,
} from "./googleConnections";
import {
  locationGroupsCreate,
  locationGroupsDelete,
  locationGroupsList,
  locationGroupsRename,
  locationGroupsSetMembers,
} from "./locationGroups";
import {
  locationsImport,
  locationsImportStatus,
  locationsList,
  locationsListAvailable,
  locationsSetStatus,
  locationsStats,
} from "./locations";
import { notificationsList, notificationsMarkRead } from "./notifications";
import { reviewsAnalytics } from "./reviewAnalytics";
import { reviewsCompetitorBenchmark } from "./reviewBenchmark";
import { reviewsClassifyTopics, reviewsTopicTrends, reviewTopicsSetAuto, reviewTopicsStatus } from "./reviewTopics";
import { reviewLinksGet, reviewLinksSave } from "./reviewLinks";
import {
  reviewRequestsCreate,
  reviewRequestsUpdate,
  reviewRequestsAddRecipients,
  reviewRequestsImportCsv,
  reviewRequestsStart,
  reviewRequestsCancel,
  reviewRequestsList,
  reviewRequestsGet,
  reviewRequestsRecipients,
} from "./reviewRequests";
import { locationPagesGet, locationPagesSet } from "./locationPages";
import { citationsAddCustom, citationsCheck, citationsCheckAll, citationsDeleteCustom, citationsList, citationsSave } from "./citations";
import {
  reviewNotesAdd,
  reviewNotesList,
  reviewsAssign,
  reviewsAssignees,
  reviewsAssignments,
} from "./reviewAssign";
import {
  reviewsExport,
  reviewsGet,
  reviewsList,
  reviewsListUnreplied,
  reviewsSync,
  reviewsSyncStatus,
} from "./reviews";
import {
  reviewRepliesApprove,
  reviewRepliesCheck,
  reviewRepliesCreateDraft,
  reviewRepliesDeletePublished,
  reviewRepliesList,
  reviewRepliesListQueue,
  reviewRepliesPublish,
  reviewRepliesReject,
  reviewRepliesSubmit,
  reviewRepliesUpdateDraft,
} from "./reviewReplies";
import {
  replyTemplatesCreate,
  replyTemplatesDelete,
  replyTemplatesList,
  replyTemplatesRender,
  replyTemplatesUpdate,
} from "./replyTemplates";
import { postsBulkCreateDrafts, postsBulkPreview } from "./postsBulk";
import {
  postsApprove,
  postsCalendar,
  postsCancel,
  postsCheck,
  postsCreateDraft,
  postsDeletePublished,
  postsGet,
  postsList,
  postsGoogleList,
  postsSyncGoogle,
  postsReject,
  postsSchedule,
  postsSubmit,
  postsUpdateDraft,
} from "./posts";
import {
  postsApproveEdit,
  postsCancelEdit,
  postsEditGet,
  postsProposeEdit,
  postsRejectEdit,
} from "./postEdits";
import {
  profileAttributesMetadata,
  profileCategoriesGet,
  profileCategoriesSuggestions,
  profileCategoriesSearch,
  profileApply,
  profileApprove,
  profileCancel,
  profileChangeSetsGet,
  profileChangeSetsList,
  profileGet,
  profilePreview,
  profilePropose,
  profileReject,
} from "./profile";
import { profileAutoRevertGet, profileAutoRevertSet } from "./profileAutoRevert";
import {
  profileChangesAccept,
  profileChangesDismiss,
  profileChangesList,
  profileChangesRevert,
} from "./profileChanges";
import {
  locationsHealthcheck,
  locationsHealthcheckSkip,
  locationsHealthcheckSummary,
} from "./healthcheck";
import { locationsOverview } from "./locationOverview";
import { locationsCenterClearManual, locationsCenterGet, locationsCenterSet } from "./locationCenter";
import { postImagesDelete, postImagesList, postImagesRename, postImagesRenderBranded } from "./postImages";
import { postImagesAddStock, postImagesGenerate, postImagesSearchStock, postImagesSources } from "./postImageSources";
import {
  postTemplatesCreate,
  postTemplatesDelete,
  postTemplatesGet,
  postTemplatesList,
  postTemplatesUpdate,
} from "./postTemplates";
import { mediaAdd, mediaCustomerList, mediaDelete, mediaList, mediaUpload, mediaUploadMany, mediaBatch, mediaCancelScheduled } from "./media";
import { foodMenusGet, foodMenusUpdate } from "./foodMenus";
import { locationManagersList } from "./locationManagers";
import {
  placeActionsCreate,
  placeActionsDelete,
  placeActionsList,
  placeActionsUpdate,
} from "./placeActions";
export { foodMenusGet, foodMenusUpdate } from "./foodMenus";
export { locationManagersList } from "./locationManagers";
import {
  suspensionCasesCreate,
  suspensionCasesList,
  suspensionCasesUpdate,
  verificationState,
} from "./verification";
import { workspaceSettingsGet, workspaceSettingsUpdate } from "./workspaceSettings";
import {
  workspacesCreate,
  workspacesDelete,
  workspacesList,
  workspacesRename,
  workspacesSetPostLanguage,
  workspacesSetSenderIdentity,
  workspacesSetHipaa,
  workspacesSetTimeSettings,
} from "./workspaces";
import {
  performanceActivity,
  performanceBackfill,
  performanceByLocation,
  performanceKeywords,
  performanceSummary,
} from "./performance";
import {
  reportsDefinitionsCreate,
  reportsDefinitionsDelete,
  reportsDefinitionsList,
  reportsDefinitionsUpdate,
  reportsDownload,
  reportsGenerate,
  reportsRunsGet,
  reportsRunsList,
  reportsShare,
  reportsShareRevoke,
} from "./reports";
import { aiVisibilityGet, aiVisibilityRunNow, aiVisibilityUpdate } from "./aiVisibility";
import {
  geogridCompetitors,
  geogridCompetitorChanges,
  geogridCompetitorProfiles,
  geogridConfigsCreate,
  geogridLocationCenter,
  geogridConfigsDelete,
  geogridConfigsList,
  geogridConfigsUpdate,
  geogridPreview,
  geogridRun,
  geogridQuickScansCreate,
  geogridRunsGet,
  geogridRunsList,
  geogridSettingsGet,
  geogridSettingsUpdate,
} from "./geogrid";
import {
  geogridByoKeyDelete,
  geogridByoKeyGet,
  geogridByoKeySet,
  geogridByoKeyVerify,
  geogridUsage,
} from "./geogridByoKey";
import { rankingsList, rankingsSetFavorite, rankingsTrack, rankingsUntrack } from "./rankings";

/** The single list of actions. Web server actions and MCP tools are both generated from it. */
import { PRIVATE_ACTIONS } from "./private";
export * from "./private";

export const actions: readonly AnyAction[] = [
  workspacesList,
  workspacesCreate,
  workspacesRename,
  workspacesDelete,
  workspacesEraseData,
  workspacesExportData,
  workspacesSetPostLanguage,
  workspacesSetSenderIdentity,
  workspacesSetHipaa,
  workspacesSetTimeSettings,
  auditList,
  auditVerify,
  auditExport,
  apiTokensList,
  apiTokensCreate,
  apiTokensRevoke,
  apiTokensCurrent,
  webhooksList,
  webhooksSubscribe,
  webhooksUnsubscribe,
  webhooksSetStatus,
  webhooksDeliveries,
  webhooksSendTest,
  googleConnectionsList,
  googleConnectionsConnect,
  googleConnectionsConnectSample,
  googleConnectionsDisconnect,
  notificationsList,
  notificationsMarkRead,
  locationsList,
  locationsListAvailable,
  locationsImport,
  locationsImportStatus,
  locationsSetStatus,
  locationsStats,
  locationGroupsList,
  locationGroupsCreate,
  locationGroupsRename,
  locationGroupsDelete,
  locationGroupsSetMembers,
  reviewsSync,
  reviewsSyncStatus,
  reviewsList,
  reviewsExport,
  reviewsGet,
  reviewsListUnreplied,
  reviewsAssign,
  reviewsAssignees,
  reviewsAssignments,
  reviewNotesAdd,
  reviewNotesList,
  reviewsAnalytics,
  reviewsCompetitorBenchmark,
  reviewLinksGet,
  reviewLinksSave,
  reviewRequestsCreate,
  reviewRequestsUpdate,
  reviewRequestsAddRecipients,
  reviewRequestsImportCsv,
  reviewRequestsStart,
  reviewRequestsCancel,
  reviewRequestsList,
  reviewRequestsGet,
  reviewRequestsRecipients,
  locationPagesGet,
  locationPagesSet,
  citationsList,
  citationsSave,
  citationsAddCustom,
  citationsDeleteCustom,
  citationsCheck,
  citationsCheckAll,
  reviewRepliesCheck,
  reviewRepliesList,
  reviewRepliesListQueue,
  reviewRepliesCreateDraft,
  reviewRepliesUpdateDraft,
  reviewRepliesSubmit,
  reviewRepliesApprove,
  reviewRepliesReject,
  reviewRepliesPublish,
  reviewRepliesDeletePublished,
  workspaceSettingsGet,
  workspaceSettingsUpdate,
  replyTemplatesList,
  replyTemplatesCreate,
  replyTemplatesUpdate,
  replyTemplatesDelete,
  replyTemplatesRender,
  postImagesList,
  postImagesRename,
  postImagesDelete,
  postImagesRenderBranded,
  postImagesSources,
  postImagesSearchStock,
  postImagesAddStock,
  postImagesGenerate,
  postTemplatesList,
  postTemplatesGet,
  postTemplatesCreate,
  postTemplatesUpdate,
  postTemplatesDelete,
  postsCheck,
  postsList,
  postsGoogleList,
  postsSyncGoogle,
  postsGet,
  postsCalendar,
  postsCreateDraft,
  postsBulkPreview,
  postsBulkCreateDrafts,
  postsUpdateDraft,
  postsSubmit,
  postsApprove,
  postsReject,
  postsSchedule,
  postsCancel,
  postsDeletePublished,
  postsProposeEdit,
  postsApproveEdit,
  postsRejectEdit,
  postsCancelEdit,
  postsEditGet,
  geogridConfigsList,
  geogridConfigsCreate,
  geogridLocationCenter,
  geogridConfigsUpdate,
  geogridConfigsDelete,
  geogridPreview,
  geogridRun,
  geogridQuickScansCreate,
  geogridRunsList,
  geogridRunsGet,
  geogridCompetitors,
  geogridCompetitorChanges,
  geogridCompetitorProfiles,
  geogridSettingsGet,
  geogridSettingsUpdate,
  aiVisibilityGet,
  aiVisibilityUpdate,
  aiVisibilityRunNow,
  geogridByoKeyGet,
  geogridByoKeySet,
  geogridByoKeyDelete,
  geogridByoKeyVerify,
  geogridUsage,
  rankingsTrack,
  rankingsUntrack,
  rankingsSetFavorite,
  rankingsList,
  performanceSummary,
  performanceKeywords,
  performanceBackfill,
  performanceByLocation,
  performanceActivity,
  reportsDefinitionsList,
  reportsDefinitionsCreate,
  reportsDefinitionsUpdate,
  reportsDefinitionsDelete,
  reportsGenerate,
  reportsRunsList,
  reportsRunsGet,
  reportsDownload,
  reportsShare,
  reportsShareRevoke,
  profileGet,
  profilePreview,
  profilePropose,
  profileApprove,
  profileReject,
  profileApply,
  profileCancel,
  profileChangeSetsList,
  profileChangeSetsGet,
  profileCategoriesSearch,
  profileCategoriesGet,
  profileCategoriesSuggestions,
  profileAttributesMetadata,
  googleNotificationsRegisterAll,
  googleNotificationsStatus,
  membersList,
  membersRemove,
  membersResetTwoFactor,
  approvalsQueue,
  approvalsCounts,
  attentionCounts,
  attentionQueue,
  onboardingGet,
  onboardingUpdate,
  aiSwitchGet,
  aiSwitchUpdate,
  aiNoticeAcknowledge,
  brandingGet,
  brandingUpdate,
  brandingLogos,
  brandingRemoveLogo,
  storageUsage,
  profileChangesList,
  profileChangesAccept,
  profileChangesRevert,
  profileChangesDismiss,
  profileAutoRevertGet,
  profileAutoRevertSet,
  mediaList,
  mediaAdd,
  mediaUpload,
  mediaUploadMany,
  mediaBatch,
  mediaCancelScheduled,
  mediaDelete,
  mediaCustomerList,
  verificationState,
  suspensionCasesList,
  suspensionCasesCreate,
  suspensionCasesUpdate,
  placeActionsList,
  placeActionsCreate,
  placeActionsUpdate,
  placeActionsDelete,
  foodMenusGet,
  foodMenusUpdate,
  locationManagersList,
  locationsHealthcheck,
  locationsHealthcheckSummary,
  locationsHealthcheckSkip,
  locationsOverview,
  locationsCenterGet,
  locationsCenterSet,
  locationsCenterClearManual,
  mcpProposalsList,
  mcpProposalsApply,
  mcpProposalsCancel,
  systemStatus,
  monitoringOverview,
  searchEverything,
  aiDraftText,
  aiDraftReply,
  aiDraftReplies,
  aiDraftBusinessDescription,
  aiDraftServiceDescription,
  aiPostIdeas,
  aiDraftPost,
  aiDraftPostVariants,
  aiVoiceGet,
  aiVoiceUpdate,
  aiClientCapSet,
  aiUsageGet,
  reviewsClassifyTopics,
  reviewsTopicTrends,
  reviewTopicsSetAuto,
  reviewTopicsStatus,
  ...PRIVATE_ACTIONS,
];
export {
  performanceActivity,
  performanceBackfill,
  performanceByLocation,
  performanceKeywords,
  performanceSummary,
} from "./performance";
export {
  reportsDefinitionsCreate,
  reportsDefinitionsDelete,
  reportsDefinitionsList,
  reportsDefinitionsUpdate,
  reportsDownload,
  reportsGenerate,
  reportsRunsGet,
  reportsRunsList,
  reportsShare,
  reportsShareRevoke,
} from "./reports";
export {
  profileAttributesMetadata,
  profileCategoriesGet,
  profileCategoriesSuggestions,
  profileCategoriesSearch,
  profileApply,
  profileApprove,
  profileCancel,
  profileChangeSetsGet,
  profileChangeSetsList,
  profileGet,
  profilePreview,
  profilePropose,
  profileReject,
} from "./profile";
export { brandingGet, brandingLogos, brandingRemoveLogo, brandingUpdate, storageUsage } from "./branding";
export { googleNotificationsRegisterAll, googleNotificationsStatus } from "./googleNotifications";
export { membersList, membersRemove, membersResetTwoFactor } from "./members";
export { approvalsCounts, approvalsQueue } from "./approvals";
export { attentionCounts, attentionQueue } from "./attention";
export { onboardingGet, onboardingUpdate } from "./onboarding";
export { aiNoticeAcknowledge, aiSwitchGet, aiSwitchUpdate } from "./aiSwitch";
export { mcpProposalsApply, mcpProposalsCancel, mcpProposalsList } from "./mcpProposals";
export { monitoringOverview } from "./monitoring";
export { systemStatus } from "./system";
export { searchEverything } from "./search";
export { aiClientCapSet, aiDraftText, aiUsageGet, aiVoiceGet, aiVoiceUpdate } from "./ai";
export { aiDraftReplies, aiDraftReply } from "./aiReplies";
export { reviewsClassifyTopics, reviewsTopicTrends, reviewTopicsSetAuto, reviewTopicsStatus } from "./reviewTopics";
export { aiDraftBusinessDescription, aiDraftServiceDescription } from "./aiDescriptions";
export { aiDraftPost, aiDraftPostVariants, aiPostIdeas } from "./aiPosts";
