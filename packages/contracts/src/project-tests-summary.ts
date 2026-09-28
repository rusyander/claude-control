/**
 * Итог прогона по статусам — отдельным листом без импортов: его берут и
 * `project-tests` (запись истории), и `project-tests-e2e` (прогон папки), а
 * общий импорт друг из друга замыкал модули в круг.
 */
export interface ProjectTestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
}
