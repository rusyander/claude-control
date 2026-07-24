import type { ProviderEnvVar } from '@claude-control/contracts';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { EnvKeyNotEncodableError } from './env-key.ts';
import { stripBom } from './text-form.ts';

/**
 * Построчная (хирургическая) правка `.env`-файла — формат переменных окружения
 * Gemini CLI (GEMINI-3).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано: Gemini CLI подхватывает переменные
 * из файла `.env` — глобального `~/.gemini/.env` и проектного
 * `<проект>/.gemini/.env`. Формат обычный dotenv: строки `КЛЮЧ=значение`,
 * комментарии `#`, пустые строки, необязательный префикс `export `, значения в
 * одинарных или двойных кавычках. В `settings.json` у Gemini map «задать env»
 * НЕТ (там только подстановка `$VAR`) — поэтому пишем именно `.env`.
 *
 * ПОЧЕМУ ПОСТРОЧНО, а не «разобрать и сгенерировать заново»: `.env` у людей —
 * рабочий файл с комментариями, группировкой и порядком, который имеет смысл.
 * Полная пересборка стёрла бы всё это. Здесь меняются ТОЛЬКО строки затронутых
 * ключей: комментарии, пустые строки, порядок и любые строки, которых правка не
 * касается, остаются байт-в-байт. Новые ключи дописываются в конец.
 *
 * FAIL-CLOSED: строка, не являющаяся ни комментарием, ни пустой, ни
 * `КЛЮЧ=значение` (в т.ч. незакрытая кавычка = многострочное значение, которое
 * панель не моделирует) → `UnrecognizedFormatError`: раздел уходит в режим
 * только для чтения, вслепую не пишем. Результат перед возвратом
 * ПЕРЕПРОВЕРЯЕТСЯ разбором — расхождение с намерением тоже fail-closed.
 */

// Переэкспорт для доменов/тестов: классы те же самые, `instanceof` цел.
export { UnrecognizedFormatError, EnvKeyNotEncodableError };

/**
 * Допустимое имя переменной в `.env`. Намеренно строго (буквы/цифры/`_`, не с
 * цифры): такое имя и читается однозначно, и переживает round-trip. Всё, что
 * шире, — не наш формат: лучше отказать, чем записать строку, которую сами же
 * потом не разберём.
 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Строка вида `KEY=value` (с необязательным `export`). Значение разбирается отдельно. */
const ASSIGNMENT_PATTERN = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Разобранная строка файла: либо присваивание, либо «чужая» строка (её не трогаем). */
interface DotenvLine {
  /** Исходный текст строки без перевода строки. */
  raw: string;
  /** Имя переменной — только у строк-присваиваний. */
  key?: string;
  /** Значение переменной (уже без кавычек/экранирования). */
  value?: string;
}

/** Значение непригодно для записи одной строкой (перевод строки внутри). */
function rejectKey(key: string): never {
  throw new EnvKeyNotEncodableError(
    key,
    'файл .env',
    'имя должно начинаться с латинской буквы или «_» и состоять из латинских букв, цифр и «_».',
  );
}

/**
 * Разобрать «хвост» строки после `=`: значение в двойных, одинарных кавычках или
 * без кавычек. Незакрытая кавычка → формат не наш (многострочные значения панель
 * не моделирует). После закрывающей кавычки допустимы только пробелы и
 * комментарий `#…`.
 */
function parseValue(rest: string): string {
  const trimmed = rest.replace(/^[ \t]+/, '');
  const quote = trimmed[0];

  if (quote === '"' || quote === "'") {
    let value = '';
    let index = 1;
    while (index < trimmed.length) {
      const char = trimmed[index]!;
      // Экранирование действует только внутри двойных кавычек (как в dotenv).
      if (char === '\\' && quote === '"' && index + 1 < trimmed.length) {
        const next = trimmed[index + 1]!;
        value +=
          next === 'n'
            ? '\n'
            : next === 'r'
              ? '\r'
              : next === 't'
                ? '\t'
                : next === '0'
                  ? '\0'
                  : next;
        index += 2;
        continue;
      }
      if (char === quote) {
        // Хвост после закрывающей кавычки: только пробелы и/или комментарий.
        const tail = trimmed.slice(index + 1).trim();
        if (tail && !tail.startsWith('#')) throw new UnrecognizedFormatError();
        return value;
      }
      value += char;
      index += 1;
    }
    // Кавычка не закрыта — многострочное значение либо битая строка.
    throw new UnrecognizedFormatError();
  }

  // Без кавычек: значение обрывается на комментарии, отделённом пробелом.
  const commentAt = trimmed.search(/\s#/);
  const body = commentAt >= 0 ? trimmed.slice(0, commentAt) : trimmed;
  return body.replace(/[ \t]+$/, '');
}

/**
 * Разобрать файл построчно. Комментарии и пустые строки помечаются «чужими»
 * (их не трогаем), присваивания — парой ключ/значение. Любая другая строка →
 * fail-closed.
 */
function parseLines(text: string): DotenvLine[] {
  const body = stripBom(text);
  if (!body) return [];
  return body.split(/\r\n|\r|\n/).map((raw): DotenvLine => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return { raw };

    const match = ASSIGNMENT_PATTERN.exec(raw);
    if (!match) throw new UnrecognizedFormatError();

    return { raw, key: match[3]!, value: parseValue(match[4]!) };
  });
}

/**
 * Прочитать переменные из `.env`. Дубликат ключа разрешается как в dotenv —
 * побеждает ПОСЛЕДНЕЕ присваивание (именно его увидит CLI).
 */
export function readDotenvVars(text: string): ProviderEnvVar[] {
  const byKey = new Map<string, string>();
  for (const line of parseLines(text)) {
    if (line.key !== undefined) byKey.set(line.key, line.value!);
  }
  return [...byKey.entries()].map(([key, value]) => ({ key, value }));
}

/**
 * Записать значение так, чтобы оно однозначно читалось обратно. Простое значение
 * пишется как есть; всё, что содержит пробелы, кавычки, `#`, `\` или управляющие
 * символы, — в двойных кавычках с экранированием.
 */
function encodeValue(value: string): string {
  if (value === '') return '';
  if (/^[^\s#'"\\]+$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Собрать новый текст `.env` для желаемого набора переменных, СОХРАНИВ всё
 * остальное: комментарии, пустые строки, порядок существующих ключей, префикс
 * `export` и исходное написание значений, которые не менялись.
 *
 * Правила:
 *  - ключ есть и в файле, и в наборе → правится ТОЛЬКО его строка, и только если
 *    значение изменилось (иначе строка остаётся байт-в-байт);
 *  - ключ есть в файле, но не в наборе → строка удаляется (пользователь удалил
 *    переменную в панели);
 *  - дубликаты одного ключа схлопываются в последнее (действующее) присваивание;
 *  - новых ключей строки дописываются в конец файла.
 *
 * Возвращает НОВЫЙ текст; сама запись — снаружи, через `safe-io` (бэкап +
 * атомарно + сохранение формы файла: BOM и CRLF).
 */
export function writeDotenvVars(text: string, vars: ProviderEnvVar[]): string {
  for (const { key } of vars) {
    if (!KEY_PATTERN.test(key)) rejectKey(key);
  }

  // Fail-closed на ВХОДЕ: файл, который мы не разбираем, перезаписывать нельзя.
  const lines = parseLines(text);

  const desired = new Map<string, string>();
  for (const { key, value } of vars) desired.set(key, value);

  // Действующее присваивание ключа — ПОСЛЕДНЕЕ: правим его, ранние дубликаты убираем.
  const lastIndexOfKey = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.key !== undefined) lastIndexOfKey.set(line.key, index);
  });

  const kept: string[] = [];
  lines.forEach((line, index) => {
    if (line.key === undefined) {
      kept.push(line.raw);
      return;
    }
    if (!desired.has(line.key) || lastIndexOfKey.get(line.key) !== index) return;

    const value = desired.get(line.key)!;
    if (value === line.value) {
      kept.push(line.raw); // Значение не менялось — строку не трогаем вовсе.
      return;
    }
    const match = ASSIGNMENT_PATTERN.exec(line.raw)!;
    kept.push(`${match[1] ?? ''}${match[2] ?? ''}${line.key}=${encodeValue(value)}`);
  });

  // Новые ключи — в конец, в порядке набора.
  const existing = new Set(lines.filter((line) => line.key !== undefined).map((line) => line.key!));
  const added = vars
    .filter(({ key }) => !existing.has(key))
    .map(({ key, value }) => `${key}=${encodeValue(value)}`);

  // Хвостовая пустая строка исходника (файл заканчивался переводом строки) —
  // сохраняем её на месте: новые ключи дописываем ПЕРЕД ней, чтобы файл и
  // остался с завершающим переводом строки, и не набрал лишних пустых строк.
  let body = kept;
  if (added.length > 0) {
    const trailing = body.length > 0 && body[body.length - 1] === '' ? body.pop()! : undefined;
    body = [...body, ...added];
    if (trailing !== undefined) body.push(trailing);
    else body.push('');
  }

  const next = body.join('\n');

  // Контроль ДО записи: результат разбирается и даёт ровно заданный набор.
  const got = readDotenvVars(next);
  const project = (list: ProviderEnvVar[]): string =>
    JSON.stringify([...list].sort((a, b) => a.key.localeCompare(b.key)));
  if (project(got) !== project(vars)) throw new UnrecognizedFormatError();

  return next;
}
