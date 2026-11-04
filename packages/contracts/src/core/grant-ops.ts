/**
 * Операции разрешения на задачу (`grantRequired`, F-31). Лист без импортов: его берут и строки
 * журнала (`journal-data.ts`), и слой человека (`user-layer.ts`) — общий модуль без цикла между ними.
 */
export const GRANT_OPS = ['edit', 'exec-db'] as const;
