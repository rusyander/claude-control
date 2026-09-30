/**
 * Тест-кейсы проекта: хранилище в `.agent/tests/`, прогоны по ним и всё, что
 * вокруг — планы, окружения, история, дефекты, импорт результатов.
 *
 * Фасад — единственный вход в раздел: маршруты не знают, что внутри лежит
 * отдельно разбор файлов, отдельно текст задания, отдельно реестры прогонов.
 * Каждый модуль сам решает, что показывать наружу; здесь только сборка.
 */
export { ProjectTestsLockedError, ProjectTestsUnavailableError } from './project-tests/files.ts';
export {
  DEFAULT_GROUPS,
  ProjectTestsError,
  ProjectTestsNotFoundError,
  SECTION_SPLIT_THRESHOLD,
  TESTS_DIR,
  applyResults,
  bulkCases,
  createGroup,
  groupFile,
  matchesFilter,
  readGroup,
  readGroups,
  removeCase,
  removeGroup,
  resetStatuses,
  selectCases,
  updateGroup,
  upsertCase,
  writeGroup,
} from './project-tests/store.ts';
export {
  declareSecret,
  defaultEnvironment,
  readEnvironments,
  readLibraryIssues,
  readSchema,
  readSharedSteps,
  readViews,
  removeEnvironment,
  removeSharedStep,
  removeView,
  saveEnvironment,
  saveSchema,
  saveSharedStep,
  saveView,
  undeclareSecret,
} from './project-tests/library.ts';
export {
  describeSecrets,
  forgetEnvironmentSecrets,
  runSecrets,
  writeSecretValue,
} from './project-tests/env-secrets.ts';
export {
  buildPoints,
  filterOfView,
  planCases,
  readPlan,
  readPlans,
  removePlan,
  savePlan,
} from './project-tests/plans.ts';
export {
  buildReport,
  evidenceOf,
  flakyCases,
  readRun,
  readRuns,
  writeRun,
} from './project-tests/runs-store.ts';
export { diffRuns, diffWithPrevious, failedCases } from './project-tests/compare.ts';
export {
  casesTouching,
  changedFiles,
  gitContext,
  impactOf,
  viewGitContext,
} from './project-tests/impact.ts';
export { historyOf } from './project-tests/history.ts';
export { ProjectTestManualRegistry, remainingPoints } from './project-tests/manual.ts';
export { availableTargets, buildDraft, createDefect } from './project-tests/defects.ts';
export { attachmentFile, saveAttachment } from './project-tests/attachments.ts';
export {
  DEFAULT_MAX_DIFF_RATIO,
  acceptBaseline,
  compareBaseline,
  readBaselines,
} from './project-tests/baselines.ts';
export { buildPrompt } from './project-tests/prompt.ts';
export {
  applyDraft,
  archiveDraft,
  draftFile,
  readDraft,
  readDraftSummaries,
  readDrafts,
  writeDraft,
  rejectDraft,
  rollbackDraft,
  summarizeDraft,
} from './project-tests/drafts.ts';
export {
  SIMILAR_LIMIT,
  SIMILAR_THRESHOLD,
  similarCases,
  similarTo,
} from './project-tests/similar.ts';
export { lintLibrary } from './project-tests/lint.ts';
export { buildQuarantine } from './project-tests/quarantine.ts';
export { buildRelease, releaseNames } from './project-tests/release.ts';
export { buildRisk, budgetOf, byRisk, riskOfCase } from './project-tests/risk.ts';
export { DEFAULT_DIFF_RANGE, collectSource, stampOf } from './project-tests/generate-sources.ts';
export { buildPlanPreview, toPlan } from './project-tests/plan-recipes.ts';
export { suggestTaxonomy } from './project-tests/taxonomy.ts';
export { conventionFile, hasConvention, installConvention } from './project-tests/convention.ts';
export { ProjectTestRunRegistry, reapProjectTestOrphans } from './project-tests/runs.ts';
export { E2E_JUNIT_REPORT, PANEL_E2E_DIR } from './project-tests/e2e-scaffold.ts';
export {
  chooseE2eFolder,
  createE2eFolder,
  e2eDirOf,
  e2eFolderView,
  removeE2eFolder,
  specFiles,
} from './project-tests/e2e-folder.ts';
export { parseSpec } from './project-tests/e2e-parse.ts';
export { AUTOMATION_FILE, automationCommand, readAutomation } from './project-tests/automation.ts';
export { assertProjectOrCopy, isProjectOrCopy } from './project-tests/project-gate.ts';
export { parsePytest } from './project-tests/e2e-parse-pytest.ts';
export {
  fullTestName,
  groupIdOfFile,
  onboardE2e,
  parseSpecFile,
  syncE2eFolder,
  syncE2eIfChanged,
} from './project-tests/e2e-sync.ts';
export { E2eRunRegistry, e2eCommand, e2eReportPath } from './project-tests/e2e-run.ts';
export { createE2eWatch, type E2eWatch } from './project-tests/e2e-watch.ts';
export { buildPyramid } from './project-tests/pyramid.ts';
export { e2eChatLine } from './project-tests/e2e-chat.ts';
export {
  repairFutureStamps,
  settleOrphanRuns,
  ORPHAN_RUN_ERROR,
  type RepairedStamp,
} from './project-tests/repair.ts';
export {
  MutationChecks,
  breakFile,
  casesForFile,
  mutationCandidates,
} from './project-tests/mutation.ts';
export { agentUpsertCase, recordAgentResults } from './project-tests/agent-write.ts';
