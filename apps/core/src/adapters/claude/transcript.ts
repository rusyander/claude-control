import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
