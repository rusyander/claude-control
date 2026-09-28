import { realpathSync } from 'node:fs';
import type { Project } from '@agentdeck/contracts';
import type { AnyPanelAction, InjectRoute } from './registry.ts';
import { readRoute } from './action-kit.ts';
import { findProject } from './actions-projects.ts';
import { samePath, worktreesOf } from './project-target.ts';

/**
 * Папка, которую агент называет сырым путём, — только проект из списка панели
 * (тем же разбором, что у остальных действий с проектом: `findProject`, id или
 * путь без учёта регистра) или, где действие это допускает, рабочая копия
 * такого проекта глазами его git. Маршруты разделов принимают любой
 * существующий каталог, а окно показывает только зарегистрированные: без
 * проверки модель писала бы и читала в папке, которой человек панели не давал.
 */

export interface RegisteredOptions {
  /** Рабочая копия зарегистрированного проекта тоже своя (git, группы по папке). */
  copies?: boolean;
}

/**
 * Путь как его видит диск: git называет копию длинным путём, а модель может
 * прислать короткий 8.3 (`RUSYAN~1`) или с другим регистром — текстом не сравнить.
 */
const onDisk = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

async function isCopyOfRegistered(inject: InjectRoute, path: string): Promise<boolean> {
  const projects = await readRoute<Project[]>(inject, '/api/projects');
  const wanted = onDisk(path);
  for (const project of projects) {
    try {
      const info = await worktreesOf(inject, project);
      const copy = (item: { path: string; isMain: boolean }) =>
        !item.isMain && samePath(onDisk(item.path), wanted);
      if (info.worktrees.some(copy)) return true;
    } catch {
      // Проект без git или пропавший каталог — копий у него нет.
    }
  }
  return false;
}

export async function assertRegistered(
  inject: InjectRoute,
  path: string,
  options: RegisteredOptions = {},
): Promise<void> {
  try {
    await findProject(inject, path);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes('is not registered')) throw error;
    if (options.copies && (await isCopyOfRegistered(inject, path))) return;
    throw new Error(
      `Folder «${path.trim()}» is not registered in the panel` +
        (options.copies ? ' and is not a working copy of a registered project' : '') +
        '. This action works only on registered projects: pick one from list_projects; ' +
        'create_project only when the human asked to add this folder.',
      { cause: error },
    );
  }
}

export interface RegisteredOnlyOptions extends RegisteredOptions {
  /** Поле входа с путём; по умолчанию `projectPath`. Пустое поле — проверки нет. */
  field?: string;
}

/**
 * Проверка папки до карточки: отпечаток считается первым, карточка — вторым
 * (`panel-agent-routes.ts`), так что отказ приходит раньше любого чтения цели и
 * без карточки. `route` не оборачивается — ведомость прав читает его исходник;
 * действие без карточки проверяет папку в своём `route` само.
 */
export function registeredOnly(
  action: AnyPanelAction,
  options: RegisteredOnlyOptions = {},
): AnyPanelAction {
  const field = options.field ?? 'projectPath';
  const check = async (input: unknown, inject: InjectRoute) => {
    const path = (input as Record<string, unknown>)[field];
    if (typeof path === 'string' && path.trim()) await assertRegistered(inject, path, options);
  };
  const { preview, fingerprint } = action;
  return {
    ...action,
    ...(fingerprint
      ? {
          fingerprint: async (input, inject) => {
            await check(input, inject);
            return fingerprint(input, inject);
          },
        }
      : {}),
    ...(preview
      ? {
          preview: async (input, inject) => {
            await check(input, inject);
            return preview(input, inject);
          },
        }
      : {}),
  };
}
