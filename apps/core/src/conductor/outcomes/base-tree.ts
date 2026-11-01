import type { Fact } from '@agentdeck/contracts/core/facts';
import { join } from 'node:path';
import { copyWithTimes, linkDir, unlinkDirLink } from '../../platform/copy-fs.ts';
import { addDetachedWorktree } from '../../platform/git.ts';
import { dropAddedWorktree } from '../../platform/git/worktree.ts';

/**
 * Дерево закреплённой базы рядом с копией (04:68-71, 04:78-79): «красный до» гоняет тест фикса на
 * базе, итог — проверку на базе для класса красного. `worktree add --detach` от копии (общий
 * каталог git), в него — файлы теста из копии (на базе их нет) и ссылки на окружение сборки копии
 * (`node_modules`, `.venv`): без них тест базы падал бы на импорте, а не на своём утверждении.
 * Снимается всегда, ссылки — до снятия: удаление дерева прошло бы сквозь ссылку в зависимости копии.
 */

export interface BaseTreeInput {
  copyDir: string;
  baseRef: string;
  /** Пустой каталог под дерево (`<core home>/tmp/checks/base-<id>`); создаёт git. */
  dir: string;
  /** Файлы от корня репозитория, переносимые из копии (тесты фикса). */
  carry: readonly string[];
  /** Каталоги от корня, где у копии лежит окружение сборки ('' — корень, иначе каталог единицы). */
  envRoots: readonly string[];
}

const ENV_DIRS = ['node_modules', '.venv'] as const;

export async function withBaseTree<T>(
  input: BaseTreeInput,
  use: (dir: string) => Promise<Fact<T>>,
): Promise<Fact<T>> {
  const added = await addDetachedWorktree(input.copyDir, input.dir, input.baseRef);
  if ('failed' in added) return { unknown: `base tree at ${input.baseRef}: ${added.failed}` };
  const links: string[] = [];
  try {
    for (const rel of input.carry) {
      const copied = copyWithTimes(join(input.copyDir, rel), join(input.dir, rel));
      if (!copied.ok) return { unknown: `carry ${rel} into the base tree: ${copied.why}` };
    }
    for (const root of new Set(input.envRoots)) {
      for (const name of ENV_DIRS) {
        const at = join(input.dir, root, name);
        const linked = linkDir(join(input.copyDir, root, name), at);
        // Нет каталога у копии — нечего связывать; `unknown` — каталог базы уже занят (отслеживаемый
        // `node_modules`?) — прогон идёт как есть, тест назовёт свою ошибку сам.
        if ('value' in linked) links.push(at);
      }
    }
    return await use(input.dir);
  } finally {
    for (const at of links) unlinkDirLink(at);
    await dropAddedWorktree(input.copyDir, input.dir, {}, 60_000);
  }
}
