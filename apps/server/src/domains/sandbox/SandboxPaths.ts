import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { removeEntry } from '../../lib/safe-io.ts';

/** Корень всех песочниц — намеренно вне каталога Claude Code: туда писать нельзя. */
export function sandboxRoot(): string {
  return join(homedir(), '.claude-control', 'sandboxes');
}

/**
 * Имя папки песочницы по её идентификатору.
 *
 * Оставляем только безопасные символы: так `../foo` не выберется за пределы
 * корня. Но у чистки есть край — id из одних запрещённых символов (`..`,
 * `///`, пустая строка) схлопывается в пустоту, и тогда `root` совпал бы с
 * самим корнем песочниц. А по этому пути `createSandbox`/`removeSandbox`
 * делают `rmSync(root, recursive)` — то есть снесли бы разом ВСЕ песочницы
 * (в каждой лежит копия .credentials.json и env MCP-серверов). Поэтому
 * вырожденный id — это ошибка, а не «корневая» песочница.
 *
 * Это же имя — ключ реестров: подметание видит на диске папки, а не id.
 */
export function sandboxKey(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) throw new Error(`Недопустимый идентификатор песочницы: ${JSON.stringify(id)}`);
  return safe;
}

export function sandboxPaths(id: string): { root: string; configDir: string; workDir: string } {
  const root = join(sandboxRoot(), sandboxKey(id));
  return { root, configDir: join(root, 'config'), workDir: join(root, 'work') };
}

/**
 * Удаление папки песочницы С ПРОВЕРКОЙ результата.
 *
 * Рекурсивный `rmSync` здесь запрещён по той же причине, что и во всех прочих
 * модулях (см. safe-io.ts): на Windows он рапортует об успехе, ничего не удалив,
 * если в пути есть нелатинские символы, — а внутрь песочницы копируются папки
 * скиллов с пользовательскими именами, то есть кириллица там ожидаема. Молчаливый
 * «успех» оставлял бы на диске копию `.credentials.json` и значения `env`
 * MCP-серверов открытым текстом, пока панель говорит «песочница стёрта».
 *
 * Поэтому удаляем поштучно через `removeEntry` и сверяемся с диском: пережила
 * папка удаление или упало само удаление (файл держит ещё не умерший процесс
 * CLI) — наружу уходит причина, а не тишина.
 */
export function removeTree(root: string): { ok: true } | { ok: false; error: string } {
  try {
    removeEntry(root);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return existsSync(root)
    ? { ok: false, error: `каталог ${root} остался на диске после удаления` }
    : { ok: true };
}
