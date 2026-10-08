import { resolve } from 'node:path';
import { z } from 'zod';
import type { Project, ProjectWorktreesInfo } from '@agentdeck/contracts';
import type { PanelPageTarget } from '@agentdeck/contracts/panel-agent';
import type { InjectRoute } from './registry.ts';
import { encode, readRoute } from './action-kit/action-kit.ts';
import { findProject } from './actions-projects/actions-projects.ts';

/**
 * Цель действий над проектом: запись реестра и, по желанию, одна из его
 * рабочих копий. Модель называет проект так же, как в `list_projects` (id или
 * путь), а копию — путём из `list_worktrees`. Путь копии, которого git этого
 * проекта не перечисляет, — отказ: иначе «копия» открывала бы git, запуск и
 * чтение кода в любом каталоге машины мимо реестра.
 */

export const projectRef = z
  .string()
  .trim()
  .min(1)
  .describe('Project id or absolute path from list_projects');

export const copyRef = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Absolute path of one of the project’s working copies (list_worktrees); omit = the project itself',
  );

export interface ProjectTarget {
  project: Project;
  /** Каталог, в котором идёт операция: сам проект или его копия. */
  dir: string;
  /** Копия, если её назвали. */
  copy?: string;
}

const norm = (path: string): string => {
  const text = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};

export const samePath = (a: string, b: string): boolean => norm(a) === norm(b);

/** Копии проекта глазами git — тем же маршрутом, что вкладка проекта. */
export async function worktreesOf(inject: InjectRoute, project: Project) {
  return readRoute<ProjectWorktreesInfo>(
    inject,
    `/api/project-git/worktrees?path=${encode(project.path)}`,
  );
}

/** Неосновная копия проекта по пути или отказ со словами для модели. */
export async function findCopy(inject: InjectRoute, project: Project, copy: string) {
  const info = await worktreesOf(inject, project);
  const found = info.worktrees.find((item) => !item.isMain && samePath(item.path, copy));
  if (!found) {
    throw new Error(
      `«${copy}» is not a working copy of project «${project.name}». Call list_worktrees for its copies.`,
    );
  }
  return found;
}

export async function resolveTarget(
  inject: InjectRoute,
  input: { project: string; copy?: string },
): Promise<ProjectTarget> {
  const project = await projectOf(inject, input);
  if (!input.copy || samePath(input.copy, project.path)) return { project, dir: project.path };
  const copy = await findCopy(inject, project, input.copy);
  return { project, dir: copy.path, copy: copy.path };
}

/**
 * Id проекта, найденного маршрутом действия, по объекту входа. `page`
 * синхронный и маршрутов не зовёт, а модель называет проект id или путём —
 * путь окно не сфокусирует. Маршрут получает тот же объект входа, что и `page`.
 */
const resolvedIds = new WeakMap<object, string>();

/** Проект по входу действия; запоминает его id для `pageFor`. */
export async function projectOf(inject: InjectRoute, input: { project: string }): Promise<Project> {
  const project = await findProject(inject, input.project);
  resolvedIds.set(input, project.id);
  return project;
}

/** Страница проекта после действия: фокус — id, найденный маршрутом. */
export function pageFor(input: { project: string }): PanelPageTarget {
  const id = resolvedIds.get(input);
  return id ? { route: '/projects', focus: id } : { route: '/projects' };
}

/** Где человек увидит итог: карточка проекта в разделе «Проекты». */
export const projectPage = (project: Project): PanelPageTarget => ({
  route: '/projects',
  focus: project.id,
});

/** Подпись каталога цели для карточки: проект, а если копия — и она. */
export const targetLabel = (target: ProjectTarget): string =>
  target.copy
    ? `${target.project.name} — ${target.copy}`
    : `${target.project.name} — ${target.dir}`;
