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
export { changedFiles, gitContext, impactOf } from './project-tests/impact.ts';
export { historyOf } from './project-tests/history.ts';
export { ProjectTestManualRegistry, remainingPoints } from './project-tests/manual.ts';
export { availableTargets, buildDraft, createDefect } from './project-tests/defects.ts';
export { saveAttachment } from './project-tests/attachments.ts';
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
export { hasConvention, installConvention } from './project-tests/convention.ts';
export { ProjectTestRunRegistry } from './project-tests/runs.ts';
export { repairFutureStamps, type RepairedStamp } from './project-tests/repair.ts';
