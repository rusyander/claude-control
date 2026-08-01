import type { Hook } from '@claude-control/contracts';
import { hookContentId } from '../hook-id.ts';
import type { AppState } from './app-store.types.ts';

/**
 * Запомнить команду хука перед тем, как он исчезнет из settings.json.
 * Без этого выключение хука было бы его удалением: файл — единственное
 * место, где живёт текст команды.
 *
 * Ключ — ВСЕГДА содержательный id, а не тот, под которым хук показан в
 * списке. В списке id бывает с префиксом файла (`local:…`) или с суффиксом
 * дубля (`-2`), а читающая сторона (`readHooks`) пересчитывает его по
 * содержимому — снимок под непересчитанным ключом потом не находился и не
 * удалялся, и выключенный хук всплывал призраком при следующей перезаписи.
 */
export function rememberDisabledHook(state: AppState, hook: Hook): void {
  const key = hookContentId(hook.event, hook.matcher, hook.command);
  state.disabledHooks[key] = { ...hook, id: key };
}

export function getDisabledHooks(state: AppState): Hook[] {
  return Object.values(state.disabledHooks);
}

/**
 * Убрать снимки хуков, которые снова лежат в файле. Вызывается ПОСЛЕ
 * перезаписи settings.json: сотри снимок раньше — и включать будет нечего.
 *
 * Сверяем не только ключ, но и содержательный id самого снимка: в состоянии
 * с прошлых версий панели лежат ключи старого, позиционного вида
 * (`Stop:0:0`). По ключу такой снимок не совпал бы ни с чем, оставался бы
 * навсегда — и стоило бы поправить команду хука в файле, как он возвращался
 * бы в список вторым, «включённым» экземпляром и снова уезжал в settings.json.
 */
export function pruneDisabledHooks(state: AppState, idsBackInFile: string[]): void {
  const back = new Set(idsBackInFile);
  for (const [key, hook] of Object.entries(state.disabledHooks)) {
    const contentId = hookContentId(hook.event, hook.matcher, hook.command);
    if (back.has(key) || back.has(contentId)) delete state.disabledHooks[key];
  }
}
