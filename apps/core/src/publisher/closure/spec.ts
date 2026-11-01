import { join } from 'node:path';

/**
 * Где лежит каталог хуков ядра для копии (05 §Push closure). Запись закрытия —
 * `platform/git/push-closure.ts`, сверка — `observer/forged-publish.ts`; адрес-заглушка и суд
 * алиасов — `lib/publish-alias.ts` (общие с наблюдателем).
 */

/** Каталог хуков копии: свой на единицу, чтобы снятие копии не трогало соседей. */
export function hooksDirOf(hooksRoot: string, taskId: string, unitId: string): string {
  return join(hooksRoot, taskId, unitId);
}
