import { readdirSync } from 'node:fs';
import { GLOB, segmentMatches } from './glob.ts';
import { canonical, isTempOutside, leavesTemp, tempOnDisk } from './paths.ts';

/**
 * Временный файл вне копии, который записал прошлый вызов этого же разговора
 * (D-10/D-11, 26.10): рецензент группы кладёт `cp f /tmp/x.bak`, правит файл,
 * возвращает его и убирает `rm /tmp/x.bak` — удаление уходило человеку, потому
 * что своё в `/tmp` — только свежий `mktemp` этой команды (F-77). Своё — путь из
 * `own` (`own-temp-evidence.ts`: его записал прошлый удавшийся вызов, и файл с
 * тех пор никто не переписывал). Шаблон — только в последнем сегменте, и своё
 * каждое совпадение на диске; совпадений нет — не своё.
 */
export function ownTempTarget(text: string, own: ReadonlySet<string> | undefined): boolean {
  if (!own || own.size === 0 || !isTempOutside(text) || leavesTemp(text)) return false;
  const disk = tempOnDisk(text);
  if (!disk) return false;
  const cut = disk.path.lastIndexOf('/');
  const dir = disk.path.slice(0, cut);
  const name = disk.path.slice(cut + 1);
  if (GLOB.test(dir)) return false;
  if (!GLOB.test(name)) return own.has(disk.path);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  const matched = entries.filter((entry) => segmentMatches(name, entry, false));
  return matched.length > 0 && matched.every((entry) => own.has(canonical(`${dir}/${entry}`)));
}

/** Временный путь в тексте команды: `/tmp/x`, `$TMPDIR/x`, `%TEMP%\x`, `$env:TEMP\x`. */
const TEMP_PATH =
  /(?:\/tmp|\/var\/tmp|\$\{?(?:TMPDIR|TEMP|TMP)\}?|%(?:TEMP|TMP)%|\$env:(?:TEMP|TMP))[\\/]([^\s;&|<>'"()`]+)/gi;
/** Слово, которым команда может убрать файл. */
const DELETES = /\b(?:rm|unlink|rmdir|shred|mv|del|erase|Remove-Item|ri)\b/i;

/**
 * Имена временных файлов, которые команда может удалить, — по ним ищется улика
 * в прошлых вызовах (`own-temp-evidence.ts`). У шаблона — его самый длинный
 * буквальный кусок (`b1r10-*.bak` → `b1r10-`): им прошлый вызов назвал файл.
 * Нет слова удаления или временного пути — пусто: транскрипт не читается.
 */
export function tempDeleteNames(command: string): string[] {
  if (!DELETES.test(command)) return [];
  const names = new Set<string>();
  for (const match of command.matchAll(TEMP_PATH)) {
    const last = (match[1] ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    const piece = last.split(/[*?[\]]/).sort((a, b) => b.length - a.length)[0] ?? '';
    if (piece.length >= 3) names.add(piece);
  }
  return [...names];
}
