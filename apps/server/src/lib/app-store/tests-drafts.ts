import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Галочка «принимать черновик генерации сразу» — по проверяемому проекту.
 *
 * Живёт в состоянии панели, а не в `.agent/tests/` проекта, намеренно: это
 * доверие ЧЕЛОВЕКА к своей же генерации, а не свойство набора тестов. В файле
 * проекта она уехала бы в git и включилась бы у каждого, кто склонировал
 * репозиторий, — то есть решение одного стало бы умолчанием для всех.
 *
 * Хранится только отклонение от умолчания: ключа нет — приёмка руками. Так
 * новый проект получает безопасное поведение, ни у кого ничего не спрашивая.
 */

/** Принимать ли черновики этого проекта без просмотра. */
export function isTestsAutoAccept(state: AppState, path: string): boolean {
  return state.testsAutoAccept?.[normalizeProjectPath(path)] === true;
}

/** Записать положение галочки. Выключенное — возврат к умолчанию, ключ удаляется. */
export function setTestsAutoAccept(state: AppState, path: string, enabled: boolean): void {
  const key = normalizeProjectPath(path);
  if (!key) return;
  if (!state.testsAutoAccept) state.testsAutoAccept = {};
  if (enabled) state.testsAutoAccept[key] = true;
  else delete state.testsAutoAccept[key];
}
