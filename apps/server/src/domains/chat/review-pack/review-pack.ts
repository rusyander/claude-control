import { fileURLToPath } from 'node:url';

/**
 * Команда пакета ревью (5.3 плана экономии): скрипт панели абсолютным путём —
 * группа зовёт его из своей копии, где `tools/` панели нет.
 */
export function reviewPackCommand(): string {
  return `node "${fileURLToPath(new URL('../../../../../../tools/review-pack.mjs', import.meta.url))}"`;
}
