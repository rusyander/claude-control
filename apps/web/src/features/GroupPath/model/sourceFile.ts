import type { StepSource } from './stepSource.types';
import { joinPath } from './joinPath';

export interface SourcePaths {
  skills: string;
  settings: string;
  claudeMd: string;
  appData: string;
  hooks: string;
}

/**
 * Файл строки в проекте. Панель знает раскладку только `.claude` (Claude):
 * у проекта другой CLI путь был бы выдумкой — пути нет.
 */
export function projectFile(source: StepSource, project: string): string | undefined {
  if (source.provider !== 'claude') return undefined;
  const id = source.id ?? '';
  if (source.kind === 'project-skill')
    return joinPath(project, '.claude', 'skills', id, 'SKILL.md');
  if (source.kind === 'rule') return joinPath(project, '.claude', 'rules', `${id}.md`);
  if (source.kind === 'hook') return joinPath(project, '.claude', 'settings.json');
  if (source.kind === 'script') return joinPath(project, '.claude', 'hooks', id);
  return undefined;
}

/** Файл, где строка живёт на диске; у стадии и скилла плагина пути нет. */
export function sourceFile(
  source: StepSource,
  paths: SourcePaths | undefined,
  hookScript?: string,
): string | undefined {
  if (source.project) return projectFile(source, source.project);
  if (!paths) return undefined;
  // Чужого скилла в нашем каталоге нет — путь туда был бы выдумкой.
  if (source.kind === 'our-skill' || source.kind === 'skill') {
    return joinPath(paths.skills, source.id ?? '', 'SKILL.md');
  }
  if (source.kind === 'prompt') return joinPath(paths.appData, 'state.json');
  if (source.kind === 'hook') return hookScript ?? paths.settings;
  if (source.kind === 'rule') return paths.claudeMd;
  if (source.kind === 'script') return joinPath(paths.hooks, source.id ?? '');
  return undefined;
}
