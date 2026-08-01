import { chmodSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isSecretFile } from './secrets.ts';

/**
 * Права доступа при атомарной записи.
 *
 * Запись через временный файл + rename СОЗДАЁТ файл заново, поэтому режим
 * целевого теряется: `~/.claude/.credentials.json` с 0600 после первой же
 * правки становится 0644 и токен читает любой пользователь машины. Поэтому
 * режим существующего файла снимаем до записи и возвращаем после неё, а у
 * нового секретного файла сразу ставим 0600. На Windows chmod трогает лишь
 * флаг «только чтение» — там это безвредный no-op.
 */

/** Режим существующего файла (только права), либо undefined — файла нет. */
export function fileMode(path: string): number | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `secretHint` — путь, по имени которого решаем «секретный ли это файл». Он
 * отличается от `path`, когда пишем сквозь символическую ссылку: режим ставим
 * реальному файлу, а секретность определяет ИМЯ ССЫЛКИ — именно его знает
 * Claude Code (`~/.claude/.credentials.json` может вести в dotfiles с любым
 * именем, 0600 всё равно обязателен).
 */
export function applyFileMode(path: string, previous: number | undefined, secretHint = path): void {
  const mode = previous ?? (isSecretFile(secretHint) || isSecretFile(path) ? 0o600 : undefined);
  if (mode === undefined) return;
  try {
    chmodSync(path, mode);
  } catch {
    // Права — страховка, а не смысл записи: файловая система без chmod
    // (сетевой диск, экзотический том) не повод считать сохранение неудачным.
  }
}

/**
 * Куда на самом деле писать: путь сам по себе или, если это символическая
 * ссылка (junction), её ЦЕЛЬ.
 *
 * Атомарная запись — это rename поверх цели, а rename поверх ссылки заменяет
 * саму ссылку обычным файлом. Люди держат `~/.claude/CLAUDE.md` и
 * `settings.json` ссылками в свой dotfiles-репозиторий (панель и сама ожидает
 * ссылки в `skills/`, см. skills.ts): после первой же правки из панели репозиторий
 * переставал бы получать изменения, а пользователь этого не заметил бы. Поэтому
 * ссылку разыменовываем и пишем в её цель — ссылка остаётся ссылкой.
 *
 * Битая ссылка (цели ещё нет) — не ошибка: `realpathSync` на ней падает, поэтому
 * цель собираем из `readlinkSync` вручную и создадим файл там, куда ссылка ведёт.
 */
export function resolveWriteTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch {
    return path; // Файла нет вовсе — пишем по исходному пути.
  }

  try {
    return realpathSync(path);
  } catch {
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      return path;
    }
  }
}
