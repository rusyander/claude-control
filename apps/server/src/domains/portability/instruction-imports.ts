import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Раскрытие `@`-импортов файла инструкций в ПЛОСКИЙ текст — с картой того,
 * откуда что пришло.
 *
 * Зачем плоский текст: у целевого CLI своего механизма импортов может не быть
 * вовсе, и тогда переехать может только собранный текст. Зачем карта: человек
 * обязан видеть, из каких файлов собрано то, что он переносит, — иначе перенос
 * незаметно увезёт чужой файл, на который просто была ссылка.
 *
 * ЦИКЛ НЕ МОЛЧИТ. Файл, который уже разворачивался, второй раз не
 * разворачивается, а строка импорта заменяется пометкой, НАЗЫВАЮЩЕЙ файл. Так
 * же поступаем с превышением глубины и с нечитаемым файлом: перенос, который
 * тихо проглотил кусок инструкций, хуже переноса, который сказал, чего в нём нет.
 */

/**
 * Предел вложенности — столько же, сколько разворачивает сам CLI. Больше —
 * пометка с именем файла, а не тихий обрыв.
 */
export const MAX_IMPORT_DEPTH = 5;

/** Больше этого файл инструкций не читается: раскрытие — не просмотр дампов. */
const MAX_IMPORT_BYTES = 1_000_000;

/**
 * Строка импорта: `@` в начале строки или после пробела, дальше путь.
 *
 * `@@` не импорт (экранирование), `@/…` тоже (абсолютный путь от корня диска —
 * такого импорта CLI не знает). А вот `@~/…` мы РАСКРЫВАЕМ: домашняя запись
 * задокументирована как обычная форма импорта, и человек ею пользуется.
 * Адрес электронной почты под правило не попадает — перед `@` в нём не пробел.
 */
const IMPORT_LINE = /(?<=^|\s)@(?!@|\/)((?:[^\s\\]|\\ )+)/g;

/** Что получилось: плоский текст, список файлов и названные проблемы. */
export interface ExpandedInstructions {
  text: string;
  /** Файлы, из которых собран текст, включая исходный, в порядке включения. */
  includes: string[];
  /** Импорты, которые не раскрыты, — каждый с причиной и именем файла. */
  problems: string[];
}

/**
 * Развернуть импорты файла. Возвращает текст, в котором каждая строка импорта
 * заменена содержимым файла, обёрнутым парой пометок с его путём: без них
 * обратный разбор не сказал бы, где кончается вставка.
 */
export function expandInstructionImports(filePath: string): ExpandedInstructions {
  const includes: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const text = expand(resolve(filePath), 0, seen, includes, problems);
  return { text, includes, problems };
}

/**
 * То же самое для КУСКА файла — одного раздела `## ПРАВИЛО:` или преамбулы
 * CLAUDE.md. Файл здесь задаёт две вещи: каталог, от которого считаются
 * относительные пути, и защиту от самоимпорта; сам он уже прочитан вызывающим,
 * поэтому второй раз не читается.
 */
export function expandInstructionText(text: string, filePath: string): ExpandedInstructions {
  const resolved = resolve(filePath);
  const includes: string[] = [resolved];
  const problems: string[] = [];
  const seen = new Set<string>([resolved.toLowerCase()]);

  return { text: expandBody(text, resolved, 1, seen, includes, problems), includes, problems };
}

function expand(
  filePath: string,
  depth: number,
  seen: Set<string>,
  includes: string[],
  problems: string[],
): string {
  const key = filePath.toLowerCase();
  if (seen.has(key)) {
    problems.push(`цикл импортов: ${filePath} уже включён выше`);
    return `<!-- импорт не раскрыт (цикл): ${filePath} -->`;
  }
  if (depth > MAX_IMPORT_DEPTH) {
    problems.push(`превышена глубина импортов (${MAX_IMPORT_DEPTH}): ${filePath}`);
    return `<!-- импорт не раскрыт (глубина ${MAX_IMPORT_DEPTH}): ${filePath} -->`;
  }

  const body = readImport(filePath);
  if (body === undefined) {
    problems.push(`импорт не прочитан: ${filePath}`);
    return `<!-- импорт не прочитан: ${filePath} -->`;
  }

  seen.add(key);
  includes.push(filePath);

  return expandBody(body, filePath, depth, seen, includes, problems);
}

/** Раскрыть импорты внутри уже прочитанного текста. */
function expandBody(
  body: string,
  filePath: string,
  depth: number,
  seen: Set<string>,
  includes: string[],
  problems: string[],
): string {
  const base = dirname(filePath);
  return body.replace(IMPORT_LINE, (match, raw: string) => {
    const target = resolveImportPath(base, raw.replace(/\\ /g, ' '));
    if (!target) return match;
    const nested = expand(target, depth + 1, seen, includes, problems);
    return [`<!-- из ${target} -->`, nested, `<!-- конец ${target} -->`].join('\n');
  });
}

/** Прочитать файл импорта. Нет, велик, не файл → `undefined` (вызывающий назовёт причину). */
function readImport(filePath: string): string | undefined {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) return undefined;
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Путь импорта: `~` от домашнего каталога, относительный — от каталога файла. */
function resolveImportPath(base: string, raw: string): string | undefined {
  const trimmed = raw.replace(/[.,;:]+$/, '');
  if (!trimmed) return undefined;
  const expanded = trimmed.startsWith('~/') ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  // Несуществующий путь импортом не считается: `@упоминание` в тексте — обычное
  // слово, и превращать его в «импорт не прочитан» значило бы врать о среде.
  return existsSync(target) ? target : undefined;
}
