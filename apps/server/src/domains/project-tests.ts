/**
 * Тест-кейсы проекта: хранилище в `.agent/tests/`, прогоны по ним и всё, что
 * вокруг — планы, окружения, история, дефекты, импорт результатов.
 *
 * Фасад — единственный вход в раздел: маршруты не знают, что внутри лежит
 * отдельно разбор файлов, отдельно текст задания, отдельно реестры прогонов.
 * Каждый модуль сам решает, что показывать наружу; здесь только сборка.
 */
export {
  DEFAULT_GROUPS,
  ProjectTestsError,
  ProjectTestsNotFoundError,
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
  defaultEnvironment,
  readEnvironments,
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
} from './project-tests/library.ts';
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
  flakyCases,
  readRun,
  readRuns,
  writeRun,
} from './project-tests/runs-store.ts';
export { changedFiles, gitContext, impactOf } from './project-tests/impact.ts';
export { historyOf } from './project-tests/history.ts';
export { ProjectTestManualRegistry, remainingPoints } from './project-tests/manual.ts';
export { availableTargets, buildDraft, createDefect } from './project-tests/defects.ts';
export { saveAttachment } from './project-tests/attachments.ts';
export { buildPrompt } from './project-tests/prompt.ts';
export { hasConvention, installConvention } from './project-tests/convention.ts';
export { ProjectTestRunRegistry } from './project-tests/runs.ts';
