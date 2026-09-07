import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Правило «подбирать модель под задачу» — по проекту.
 *
 * Хранится только ОТКЛОНЕНИЕ от умолчания: ключа нет — правило включено. Так
 * новый проект получает подбор сразу (владелец просил «чтобы не вспоминать»), а
 * файл состояния не копит записи обо всех проектах, где ничего не трогали.
 *
 * Ключ — нормализованный путь проекта, как у `runnerCommands` и
 * `projectCodeViews`. Кому этот ключ соответствует для конкретной рабочей папки
 * (подпапка проекта, копия ветки) — решает домен: здесь только чтение и запись.
 */

/** Явно записанное положение тумблера. `undefined` — по умолчанию, включено. */
export function getProjectCascade(state: AppState, path: string): boolean | undefined {
  return state.projectCascade[normalizeProjectPath(path)];
}

/** Все записанные положения: домен ищет среди них подходящее рабочей папке. */
export function projectCascadeEntries(state: AppState): Array<[string, boolean]> {
  return Object.entries(state.projectCascade);
}

/**
 * Записать положение. Включённое — это возврат к умолчанию, поэтому ключ не
 * пишется, а удаляется: иначе «включено» существовало бы в двух видах, и первая
 * же смена умолчания разошлась бы с тем, что человек видит в тумблере.
 */
export function setProjectCascade(state: AppState, path: string, enabled: boolean): void {
  const key = normalizeProjectPath(path);
  if (!key) return;
  if (enabled) delete state.projectCascade[key];
  else state.projectCascade[key] = false;
}
