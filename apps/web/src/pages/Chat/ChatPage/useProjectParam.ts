import { useEffect, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import type { ProjectInfo } from '@entities/Project';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Имя вкладки для каталога, которого нет в списке проектов: последняя часть пути. */
function nameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Проект, который открывает адрес `?project=`: каталог из списка — со своим именем, неизвестный —
 * с последней частью пути. Список ещё грузится (`undefined`) — `null`: открыть вкладку раньше
 * списка значило бы навсегда назвать проект из списка частью пути (живой прогон 06.11:
 * имя папки вместо имени из списка).
 */
export function projectFromParam(
  project: string | undefined,
  projects: ProjectInfo[] | undefined,
): ProjectInfo | null {
  if (!project || projects === undefined) return null;
  const key = normalizeProjectPath(project);
  const known = projects.find((item) => normalizeProjectPath(item.path) === key);
  return (
    known ?? { path: project, name: nameOf(project), exists: true, lastActivity: '', chats: [] }
  );
}

/**
 * `/chat?project=<каталог>` (W3-17a): адрес открывает вкладку этого проекта — с ним приходят
 * старая ссылка `/core/chat?project=` и «Новый» из списка проектов. Открывается один раз на
 * значение и после того, как список проектов пришёл (`projects` — `undefined`, пока грузится;
 * ошибка списка — пустой массив, тогда имя из пути): параметр дальше снимает обычная запись
 * адреса чата, а человек может уйти в другую вкладку.
 */
export function useProjectParam(
  projects: ProjectInfo[] | undefined,
  openProject: (project: ProjectInfo) => void,
): void {
  const { project } = useSearch({ strict: false }) as { project?: string };
  const opened = useRef<string | undefined>(undefined);
  // Параметр, ждущий списка: запись адреса чата может снять `?project=` раньше, чем список пришёл
  // (живой прогон 06.11: вкладка каталога вне списка не открывалась), — значение помнится здесь.
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (project && project !== opened.current) pending.current = project;
    const want = pending.current;
    if (!want) return;
    const target = projectFromParam(want, projects);
    if (!target) return;
    pending.current = undefined;
    opened.current = want;
    openProject(target);
  }, [project, projects, openProject]);
}
