import type { SearchResultKind } from '@claude-control/contracts';

/** Короче двух символов запрос неинформативен — такой поиск не запускаем. */
export const MIN_QUERY_LENGTH = 2;

/** Раздел → путь его страницы (без ведущего слэша): клиент открывает `/<pagePath>?id=<id>`. */
export const PAGE_PATH: Record<SearchResultKind, string> = {
  rule: 'rules',
  skill: 'skills',
  hook: 'hooks',
  script: 'scripts',
  permission: 'permissions',
  env: 'env',
  mcp: 'mcp',
  plugin: 'plugins',
  // Раздел глобальных инструкций живёт на том же пути у всех провайдеров —
  // страница сама роутится по активному (CLAUDE.md / AGENTS.md / GEMINI.md).
  instructions: 'claude-md',
  group: 'groups',
};
