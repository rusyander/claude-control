/**
 * Тест-кейсы проекта: хранилище в `.agent/tests/`, прогоны по ним и всё, что
 * вокруг — планы, окружения, история, дефекты, импорт результатов.
 *
 * Фасад — единственный вход в раздел: маршруты не знают, что внутри лежит
 * отдельно разбор файлов, отдельно текст задания, отдельно реестры прогонов.
 * Каждый модуль сам решает, что показывать наружу; здесь только сборка.
 */
export { ProjectTestsLockedError, ProjectTestsUnavailableError } from './files.ts';
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
} from './store/store.ts';
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
} from './library/library.ts';
export {
  describeSecrets,
  forgetEnvironmentSecrets,
  runSecrets,
  writeSecretValue,
} from './env-secrets/env-secrets.ts';
export {
  buildPoints,
  filterOfView,
  planCases,
  readPlan,
  readPlans,
  removePlan,
  savePlan,
} from './plans/plans.ts';
export {
  buildReport,
  evidenceOf,
  flakyCases,
  readRun,
  readRuns,
  writeRun,
} from './runs-store/runs-store.ts';
export { diffRuns, diffWithPrevious, failedCases } from './compare/compare.ts';
export {
  casesTouching,
  changedFiles,
  gitContext,
  impactOf,
  viewGitContext,
} from './impact/impact.ts';
export { historyOf } from './history/history.ts';
export { ProjectTestManualRegistry, remainingPoints } from './manual/manual.ts';
export { availableTargets, buildDraft, createDefect } from './defects/defects.ts';
export { attachmentFile, saveAttachment } from './attachments/attachments.ts';
export {
  DEFAULT_MAX_DIFF_RATIO,
  acceptBaseline,
  compareBaseline,
  readBaselines,
} from './baselines/baselines.ts';
export { buildPrompt } from './prompt/prompt.ts';
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
} from './drafts/drafts.ts';
export { SIMILAR_LIMIT, SIMILAR_THRESHOLD, similarCases, similarTo } from './similar/similar.ts';
export { lintLibrary } from './lint/lint.ts';
export { buildQuarantine } from './quarantine/quarantine.ts';
export { buildRelease, releaseNames } from './release/release.ts';
export { buildRisk, budgetOf, byRisk, riskOfCase } from './risk/risk.ts';
export { DEFAULT_DIFF_RANGE, collectSource, stampOf } from './generate-sources/generate-sources.ts';
export { buildPlanPreview, toPlan } from './plan-recipes/plan-recipes.ts';
export { suggestTaxonomy } from './taxonomy/taxonomy.ts';
export { conventionFile, hasConvention, installConvention } from './convention/convention.ts';
export { ProjectTestRunRegistry, reapProjectTestOrphans } from './runs/runs.ts';
export { E2E_JUNIT_REPORT, PANEL_E2E_DIR } from './e2e-scaffold.ts';
export {
  chooseE2eFolder,
  createE2eFolder,
  e2eDirOf,
  e2eFolderView,
  removeE2eFolder,
  specFiles,
} from './e2e-folder/e2e-folder.ts';
export { parseSpec } from './e2e-parse.ts';
export { AUTOMATION_FILE, automationCommand, readAutomation } from './automation/automation.ts';
export { assertProjectOrCopy, isProjectOrCopy } from './project-gate.ts';
export { parsePytest } from './e2e-parse-pytest.ts';
export {
  fullTestName,
  groupIdOfFile,
  onboardE2e,
  parseSpecFile,
  syncE2eFolder,
  syncE2eIfChanged,
} from './e2e-sync/e2e-sync.ts';
export { E2eRunRegistry, e2eCommand, e2eReportPath } from './e2e-run/e2e-run.ts';
export { createE2eWatch, type E2eWatch } from './e2e-watch/e2e-watch.ts';
export { buildPyramid } from './pyramid/pyramid.ts';
export { e2eChatLine } from './e2e-chat.ts';
export {
  repairFutureStamps,
  settleOrphanRuns,
  ORPHAN_RUN_ERROR,
  type RepairedStamp,
} from './repair/repair.ts';
export {
  MutationChecks,
  breakFile,
  casesForFile,
  mutationCandidates,
  sweepMutationCopies,
} from './mutation/mutation.ts';
export { agentUpsertCase, recordAgentResults } from './agent-write/agent-write.ts';
