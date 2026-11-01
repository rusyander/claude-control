/**
 * `@agentdeck/stub-forge` — ОДНА заглушка форжа ядра (этап 6, как stub-model для модели): GitLab
 * v4 и GitHub REST + GraphQL в подмножестве публикатора, память с засевом, сценарии по имени,
 * сбои (код, мусор, зависание, обрыв), лента событий с автором, след каждого запроса без значений
 * доступа, пояс P63 (слияние и одобрение — 404 и строка следа). Только loopback.
 *
 * Простой ESM без зависимостей и без сборки: его грузят и vitest ядра (типы — `index.d.mts`),
 * и голый `node tools/qa/*.mjs`.
 */
export { closedPortUrl, FORBIDDEN_SEGMENT, RESERVED_PORTS, startStubForge } from './server.mjs';
export { GRAPHQL_FORBIDDEN } from './github-graphql.mjs';
export { REVIEW_THREAD_BODIES, SCENARIO_NAMES } from './scenarios.mjs';
export { DEFAULT_PROJECT, DEFAULT_USERS, mrBodyHash, sha256, stubAccess } from './state.mjs';
