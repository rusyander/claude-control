import type { Group } from '@claude-control/contracts';
import { normalizeProjectPath } from '../lib/app-store/projects.ts';
import { WORKTREES_DIR_SUFFIX } from './project-git/worktrees.ts';
import type { EntityToggleDeps } from './entity-toggle.ts';
import { setGroupEnabled } from './group-toggle.ts';

/**
 * Привязка группы к проекту: набор включается сам, когда агент работает в этом
 * каталоге.
 *
 * Без этого группа остаётся закладкой — человек всё равно вспоминает и щёлкает
 * тумблер руками. Включение живёт на сервере, а не в интерфейсе, потому что
 * прогон запускают ещё телефон и разделение задач по чатам: сделай это клиент,
 * набор применялся бы только в браузере.
 *
 * ВКЛЮЧАЕМ, НО НЕ ВЫКЛЮЧАЕМ. Группа правит общие файлы `~/.claude`, а прогонов
 * одновременно идёт несколько — в том числе в копиях веток. Гашение по выходу
 * из проекта било бы по чужому живому агенту, и виноватого он бы не нашёл.
 */

/**
 * Относится ли рабочая папка к проекту, к которому привязана группа.
 *
 * Кроме самого каталога и вложенных в него, сюда попадают копии веток: они
 * лежат в СОСЕДНЕМ каталоге `<репозиторий>-worktrees/<ветка>` (иначе сборщики
 * и наблюдатели файлов ушли бы в копию рекурсивно). Для человека это тот же
 * проект, и набор в копии должен быть тем же.
 */
export function matchesProject(projectPath: string, cwd: string): boolean {
  const project = normalizeProjectPath(projectPath);
  const target = normalizeProjectPath(cwd);
  if (!project) return false;

  return (
    target === project ||
    target.startsWith(`${project}/`) ||
    target.startsWith(`${project}${WORKTREES_DIR_SUFFIX}/`)
  );
}

/** Группы, привязанные к этой рабочей папке, в порядке их списка. */
export function groupsForCwd(groups: Group[], cwd: string): Group[] {
  if (!cwd) return [];
  return groups.filter((group) =>
    (group.projectPaths ?? []).some((path) => matchesProject(path, cwd)),
  );
}

/**
 * Включить группы, привязанные к рабочей папке прогона. Уже включённая группа
 * не трогается вовсе — ни одной записи на диск, поэтому вызов на каждом
 * сообщении ничего не стоит.
 *
 * Возвращает имена включённых групп: маршрут отдаёт их клиенту, чтобы человек
 * увидел, что набор сменился не сам по себе.
 */
export function activateGroupsForCwd(deps: EntityToggleDeps, cwd: string): { activated: string[] } {
  const activated: string[] = [];

  for (const group of groupsForCwd(deps.store.getGroups(), cwd)) {
    if (group.isEnabled) continue;
    setGroupEnabled(deps, group, true);
    activated.push(group.name);
  }

  return { activated };
}

/**
 * То же самое перед запуском прогона, заведённого не отправкой из поля ввода:
 * разделение задач и продолжение в чистой сессии стартуют агента сами, и без
 * этого вызова правила и скиллы набора до него не доезжали — набор включался бы
 * только со следующего сообщения, набранного руками.
 *
 * Осечка не имеет права ронять прогон: набор не главнее разговора. Поэтому
 * ошибка уходит в `onError` вызывающего (там есть логгер), а не наружу.
 */
export function activateGroupsQuietly(
  deps: EntityToggleDeps,
  cwd: string,
  onError?: (error: unknown) => void,
): void {
  try {
    activateGroupsForCwd(deps, cwd);
  } catch (error) {
    onError?.(error);
  }
}
