import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ownsJsonlTranscript } from '../transcript-owner.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Транскрипт разговора Claude Code на месте (P15, 03:150-155): `--resume <id>` продолжает только
 * разговор, чей файл `<каталог конфигурации>/projects/<папка проекта>/<id>.jsonl` лежит на диске.
 * Имя папки проекта CLI выводит из cwd по своему правилу (регистр буквы диска, длинные пути) —
 * ядро его не повторяет, а ищет файл в каждой папке проектов: имя файла — сам id разговора.
 * Каталога проектов нет — транскрипта нет (`false`); не читается — неизвестно (`undefined`):
 * судья тогда не форсирует новый сеанс и не продолжает кончившийся.
 */
export function claudeTranscriptPresent(
  pin: Record<string, string>,
  conversationId: string,
): boolean | undefined {
  const projects = join(claudeConfigDir(pin), 'projects');
  if (!existsSync(projects)) return false;
  try {
    const file = `${conversationId}.jsonl`;
    return readdirSync(projects, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(projects, entry.name, file)),
    );
  } catch {
    return undefined;
  }
}

/** Id разговора Claude Code — UUID; иная форма не имя файла транскрипта, а попытка его подобрать. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Разговор, начатый не ядром, — этого корня (этап 10, F2; `CliAdapter.ownsTranscript`). Доказано,
 * только если файл `<id>.jsonl` лежит в хранилище CLI и его строки этого же id называют своей
 * папкой `root` (сравнение путей платформы: 8.3, регистр диска, косые). Id не формы UUID, файла нет,
 * он другого корня или в его голове нет строки этого id с папкой — `false`; не читается — `undefined`.
 */
export function claudeOwnsTranscript(
  pin: Record<string, string>,
  root: string,
  conversationId: string,
): boolean | undefined {
  if (!CLAUDE_SESSION_ID.test(conversationId)) return false;
  return ownsJsonlTranscript(join(claudeConfigDir(pin), 'projects'), null, root, conversationId);
}
