/**
 * Лог подготовки копии для глаз: без шума установщиков и с первой строкой
 * настоящей ошибки.
 *
 * Живое ревью MR (13.10.2026): в первое сообщение группы уехало ~2,5 тыс.
 * символов `npm warn EBADENGINE` — токены ушли на предупреждения, а причина
 * провала (код 2) осталась под ними. Полный лог лежит в файле; в карточку и в
 * задание идёт то, что отличает провал от шума.
 */

/** Предупреждения и объявления установщиков, в том числе с меткой каталога `[web] `. */
const NOISE_LINE =
  /^\s*(?:\[[^\]\r\n]*\]\s+)?(?:npm\s+(?:warn|WARN|notice)\b|WARN\s{1,2}\S|warning\b[^\r\n]*|yarn\s+warn\b|pnpm\s+warn\b|WARNING:\s)/;

/** Строки самой панели: заголовок запуска, отметки времени и кода. Ошибкой установщика не считаются. */
const PANEL_LINE =
  /^\s*(?:\[[^\]\r\n]*\]\s+)?(?:\$ |\[\d{4}-\d{2}-\d{2}T|\[потолок|\[lock-файлы|\[панель)/;

const ERROR_LINE =
  /\b(?:npm\s+(?:error|ERR!)|ERR_[A-Z_]+|ERESOLVE|ENOENT|EACCES|EPERM|EBUSY|ETIMEDOUT|ENOTFOUND|E404|fatal|FAILED|Traceback|ModuleNotFoundError|No matching distribution|missing go\.sum|cannot find|not found|command failed|is not recognized)\b|\berror\b|\bfailed\b/i;

/** Лог без строк предупреждений. */
export function quietLog(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !NOISE_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const FIRST_ERROR_MAX = 300;

/**
 * Первая строка ошибки провалившегося запуска. Нет строки с признаками ошибки —
 * последняя значащая строка после отсева шума: у `npm ci` с кодом 2 это и есть
 * причина.
 */
export function firstErrorLine(text: string): string | undefined {
  const lines = quietLog(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !PANEL_LINE.test(line));
  const hit = lines.find((line) => ERROR_LINE.test(line)) ?? lines.at(-1);
  if (!hit) return undefined;
  return hit.length > FIRST_ERROR_MAX ? `${hit.slice(0, FIRST_ERROR_MAX)}…` : hit;
}
