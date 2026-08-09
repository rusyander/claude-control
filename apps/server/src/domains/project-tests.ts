/**
 * Тест-кейсы проекта: хранилище в `.agent/tests/` и прогоны агента по ним.
 *
 * Фасад — единственный вход в раздел: маршруты не знают, что внутри лежит
 * отдельно разбор файлов, отдельно текст задания и отдельно реестр прогонов.
 */
export {
  DEFAULT_GROUPS,
  ProjectTestsError,
  TESTS_DIR,
  createGroup,
  groupFile,
  readGroups,
  removeCase,
  removeGroup,
  resetStatuses,
  upsertCase,
} from './project-tests/store.ts';
export { buildPrompt } from './project-tests/prompt.ts';
export { hasConvention, installConvention } from './project-tests/convention.ts';
export { ProjectTestRunRegistry } from './project-tests/runs.ts';
