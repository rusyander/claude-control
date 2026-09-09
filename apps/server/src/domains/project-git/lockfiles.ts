import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './exec.ts';

/**
 * Lock-файлы, которые установка зависимостей переписывает у себя под ногами.
 *
 * Установка в копии идёт в режиме `ci` / `--frozen-lockfile`, и в норме дерево
 * после неё чистое. Но менеджер пакетов другой версии, чем у автора lock-файла,
 * переписывает его «под себя» даже в замороженном режиме (pnpm меняет
 * `lockfileVersion`, npm пересобирает `packages`), а команда проекта может и
 * не быть замороженной. Первый ход агента в такой копии — откат этого файла,
 * иначе он уедет в коммит: так и было на живом разделении 09.09.2026.
 */
export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/**
 * Разбор `git status --porcelain -z`: путь и то, отслеживается ли файл.
 * Формат: два символа статуса, пробел, путь; переименования (`R`) в списке
 * lock-файлов не встречаются — их `git status` для явных путей не показывает.
 */
export function parseChurn(stdout: string): Array<{ path: string; tracked: boolean }> {
  return stdout
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => ({ path: entry.slice(3), tracked: !entry.startsWith('??') }));
}

/**
 * Вернуть lock-файлы копии к версии из индекса; появившиеся заново — убрать.
 * Возвращает, что откатилось, — для лога установки и карточки копии. Копия
 * без git (или git без ответа) — ничего не трогаем: откатывать неоткуда.
 */
export async function revertLockfileChurn(dir: string): Promise<string[]> {
  let status: string;
  try {
    status = await git(dir, ['status', '--porcelain', '-z', '--', ...LOCKFILES]);
  } catch {
    return [];
  }
  const churn = parseChurn(status);
  if (churn.length === 0) return [];

  const tracked = churn.filter((item) => item.tracked).map((item) => item.path);
  if (tracked.length > 0) {
    await git(dir, ['checkout', '--', ...tracked]);
  }
  for (const item of churn.filter((entry) => !entry.tracked)) {
    await rm(join(dir, item.path), { force: true });
  }
  return churn.map((item) => item.path);
}
