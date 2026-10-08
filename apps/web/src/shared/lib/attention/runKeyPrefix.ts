/** Префикс ключей одного прогона — по нему забывается его прошлый повод. */
export const runKeyPrefix = (runId: string): string => `run:${runId}:`;
