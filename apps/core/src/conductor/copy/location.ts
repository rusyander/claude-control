import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Где лежит копия единицы (перенесено из панели, `project-git/worktrees.ts`): соседний каталог
 * `<репозиторий>-worktrees/<имя ветки>`. Рядом с репозиторием, а не внутри: копия внутри основной
 * копии видна её `git status` и инструментам проекта как чужой каталог.
 */

export const WORKTREES_DIR_SUFFIX = '-worktrees';

/**
 * Предел имени каталога: на Windows путь упирается в 260 знаков, и имя ветки из тикета съело бы
 * запас глубокого репозитория. Длинное имя режется и получает хвост sha1 — своё у каждой ветки.
 */
const DIR_NAME_MAX = 40;

function shorten(value: string): string {
  if (value.length <= DIR_NAME_MAX) return value;
  const tag = createHash('sha1').update(value).digest('hex').slice(0, 6);
  const head = value.slice(0, DIR_NAME_MAX - tag.length - 1).replace(/[-.]+$/, '');
  return `${head}-${tag}`;
}

/**
 * Имя каталога из имени ветки: `feature/parallel` → `feature-parallel`. Буквы любого алфавита
 * остаются, всё, что путает файловую систему, схлопывается в дефис. Пустое имя и
 * зарезервированные имена Windows (CON, PRN, COM1…) не создаются — обе беды лечит суффикс.
 * Устройство Windows узнаёт по части ДО первой точки (`CON.txt` — тоже консоль) и по надстрочным
 * цифрам (`COM¹`), поэтому суффикс встаёт сразу за этой частью: `CON-wt.txt`.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)/i;

export function worktreeDirName(branch: string): string {
  const safe = branch
    .replace(/[\\/]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!safe) return 'wt';
  return shorten(safe.replace(RESERVED, '$1-wt'));
}

/** Каталог копии ветки; `root` — свой корень копий вместо соседнего (настройка вызывающего). */
export function copyDirFor(mainPath: string, branch: string, root?: string): string {
  const base = root ?? join(dirname(mainPath), `${basename(mainPath)}${WORKTREES_DIR_SUFFIX}`);
  return join(base, worktreeDirName(branch));
}
