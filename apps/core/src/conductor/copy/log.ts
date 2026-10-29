/**
 * Лог установки для глаз и для шага (перенесено из панели, `project-git/bootstrap-log.ts`):
 * без шума установщиков и с первой строкой настоящей ошибки. Живое ревью панели 13.10: в первое
 * сообщение группы уехало ~2,5 тыс. знаков `npm warn EBADENGINE`, а причина провала (код 2)
 * осталась под ними. Полный лог лежит файлом; в решение и шаг идёт то, что отличает провал от шума.
 */

/** Предупреждения и объявления установщиков, в том числе с меткой каталога `[web] `. */
const NOISE_LINE =
  /^\s*(?:\[[^\]\r\n]*\]\s+)?(?:npm\s+(?:warn|WARN|notice)\b|WARN\s{1,2}\S|warning\b[^\r\n]*|yarn\s+warn\b|pnpm\s+warn\b|WARNING:\s)/;

/** Строки самого ядра в логе: заголовок запуска, отметки кода и срока. Ошибкой не считаются. */
const CORE_LINE = /^\s*(?:\[[^\]\r\n]*\]\s+)?(?:\$ |\[core\b)/;

const ERROR_LINE =
  /\b(?:npm\s+(?:error|ERR!)|ERR_[A-Z_]+|ERESOLVE|ENOENT|EACCES|EPERM|EBUSY|ETIMEDOUT|ENOTFOUND|E404|fatal|FAILED|Traceback|ModuleNotFoundError|No matching distribution|missing go\.sum|cannot find|not found|command failed|is not recognized)\b|\berror\b|\bfailed\b/i;

export const FIRST_ERROR_MAX = 300;
export const LOG_TAIL_MAX = 2_000;

export function quietLog(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !NOISE_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Строка — настоящая ошибка (не шум, не строка ядра). Признак для потока установки: первая такая
 * строка ловится по ходу вывода, а не в удержанных 64 КБ, у которых длинный лог теряет начало.
 */
export function isErrorLine(line: string): boolean {
  return !NOISE_LINE.test(line) && !CORE_LINE.test(line) && ERROR_LINE.test(line);
}

/** Первая строка ошибки; нет признака ошибки — последняя значащая после отсева шума. */
export function firstErrorLine(text: string): string | undefined {
  const lines = quietLog(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !CORE_LINE.test(line));
  const hit = lines.find((line) => ERROR_LINE.test(line)) ?? lines.at(-1);
  if (!hit) return undefined;
  return hit.length > FIRST_ERROR_MAX ? `${hit.slice(0, FIRST_ERROR_MAX)}…` : hit;
}

/** Хвост тихого лога, режется с начала целой строки: оборванная первая строка путает модель. */
export function logTail(text: string, max = LOG_TAIL_MAX): string {
  const quiet = quietLog(text).trim();
  if (quiet.length <= max) return quiet;
  const cut = quiet.slice(quiet.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}
