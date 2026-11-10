/**
 * `@agentdeck/stub-tracker` — ОДНА заглушка трекера (этап 12, как stub-forge для форжа): Jira
 * облака (Basic) и своей установки (Bearer) в подмножестве клиента `@agentdeck/trackers`, экранов
 * Jira панели и снимка приёма; память с засевом, подмножество JQL, сбои (код, мусор, зависание,
 * обрыв), след каждого запроса без значений доступа. Только loopback.
 *
 * Простой ESM без зависимостей и без сборки: его грузят и vitest пакетов, и голый `node`.
 */
export { RESERVED_PORTS, startStubTracker } from './server.mjs';
export { JqlError, parseJql } from './jql.mjs';
export {
  ACCEPTANCE_FIELD_ID,
  ACCEPTANCE_FIELD_NAME,
  DEFAULT_ISSUES,
  DEFAULT_PROJECTS,
  DEFAULT_USERS,
  stubTrackerToken,
  WORKFLOW,
} from './state.mjs';
