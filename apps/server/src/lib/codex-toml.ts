import { parse as parseToml } from 'smol-toml';
import { UnrecognizedFormatError } from './format-errors.ts';
import { blockToEol, detectEol, stripBom } from './text-form.ts';

/**
 * Общие примитивы хирургической правки `~/.codex/config.toml`.
 *
 * Codex-конфиг разделяют несколько разделов панели (MCP-серверы, переменные
 * окружения, в будущем — права). Все правят его ОДИНАКОВО безопасно: находят в
 * тексте непрерывный регион таблиц с нужным префиксом (`[mcp_servers…]`,
 * `[shell_environment_policy…]`), вырезают его и вставляют заново сгенерированный
 * блок; ВСЁ вне региона (model, approval_policy, комментарии, чужие секции)
 * остаётся байт-в-байт. Здесь — переиспользуемое ядро этой хирургии; конкретный
 * раздел лишь задаёт префикс таблицы и генерирует блок из своего объекта.
 *
 * FAIL-CLOSED: если config.toml не парсится, регион префикса разорван (таблицы
 * встречаются в нескольких местах) или ключ задан inline/dotted на верхнем уровне
 * — формат неоднозначен, бросаем `UnrecognizedFormatError` и НЕ пишем.
 */

// Переэкспорт для доменов/маршрутов/тестов: объявление живёт в
// `lib/format-errors.ts` (сигнал общий для всех форматов, не только TOML), класс
// тот же самый, `instanceof` цел.
export { UnrecognizedFormatError };

/**
 * Разобрать config.toml. Невалидный TOML → fail-closed (read-only).
 *
 * BOM снимается перед разбором: с ведущим U+FEFF TOML-парсер падает на совершенно
 * валидном файле (так его сохраняют Блокнот и PowerShell), и раздел уходил бы в
 * fail-closed на здоровом конфиге. Сам байт BOM при хирургической правке остаётся
 * в файле — мы правим ИСХОДНЫЙ текст, а не пересобираем его.
 */
export function parseCodexToml(text: string): Record<string, unknown> {
  try {
    return parseToml(stripBom(text)) as Record<string, unknown>;
  } catch {
    throw new UnrecognizedFormatError();
  }
}

/**
 * Стабильная строковая проекция значения — для сравнения намерения и результата
 * записи независимо от порядка ключей и формы TOML (inline ↔ таблица).
 */
export function stableToml(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableToml).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableToml(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Найти и заменить в тексте config.toml регион таблиц с префиксом `prefix` на
 * сгенерированный блок. ВСЁ вне региона остаётся байт-в-байт. Регион — непрерывная
 * полоса таблиц `[prefix]` / `[prefix.<...>]` (и `[[…]]`) от первой такой
 * строки-заголовка до следующего заголовка НЕ из этого префикса (или до конца
 * файла).
 *
 * Fail-closed: если таблицы префикса не непрерывны (встречаются в нескольких
 * местах) или ключ объявлен вне заголовка таблицы (например, dotted/inline
 * `prefix.x = …` или `prefix = { … }` на верхнем уровне) — формат неоднозначен,
 * бросаем `UnrecognizedFormatError` и НЕ пишем.
 *
 * `prefix` — имя таблицы (`mcp_servers`, `shell_environment_policy`). `block` —
 * уже сериализованный TOML-текст региона (или пустая строка, чтобы удалить регион).
 */
/** Экранировать строку для вставки в регулярное выражение. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Вставить или обновить СКАЛЯРНЫЙ ключ КОРНЯ документа `config.toml`
 * (`approval_policy = "…"`, `sandbox_mode = "…"`). В отличие от
 * `spliceCodexTableRegion` (хирургия ТАБЛИЦ) — это правка одной строки-присваивания
 * на верхнем уровне.
 *
 * Корневой регион = от начала файла до первой строки-заголовка таблицы (`^\s*\[`).
 * Только в нём:
 * - если ключ уже есть (`key = …` на верхнем уровне) — заменяется ТОЛЬКО значение
 *   (ключ, отступ, пробелы и хвостовой inline-комментарий сохраняются);
 * - если ключа нет — добавляется строка `key = "value"` в конец корневого региона,
 *   перед первым `[table]` (после существующих корневых строк, до пустых строк,
 *   отделяющих таблицу).
 *
 * Одноимённые ключи ВНУТРИ таблиц (`[profiles.x]`, `[mcp_servers.y]` и т.п.) НИКОГДА
 * не трогаются — они лежат за границей корневого региона. Всё прочее (таблицы,
 * комментарии, другие корневые ключи) остаётся БАЙТ-В-БАЙТ. Значение пишется как
 * TOML-строка в кавычках.
 */
export function upsertCodexRootScalar(original: string, key: string, value: string): string {
  const lines = original.split('\n');
  const usesCrlf = lines.some((line) => line.endsWith('\r'));
  const cr = usesCrlf ? '\r' : '';

  // Граница корневого региона — первая строка-заголовок таблицы `[...]`.
  let tableStart = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i]!.replace(/\r$/, ''))) {
      tableStart = i;
      break;
    }
  }

  const encodedValue = JSON.stringify(value); // TOML basic string (кавычки + экранирование).
  const keyName = `(?:${escapeRegExp(key)}|"${escapeRegExp(key)}")`;
  // Присваивание ключа на верхнем уровне: `key = <value><опц. пробелы/комментарий>`.
  const assignRe = new RegExp(`^(\\s*${keyName}\\s*=\\s*)(.*?)(\\s*(?:#.*)?)$`);

  // 1) Ключ уже есть в корневом регионе → меняем только значение, храня комментарий.
  for (let i = 0; i < tableStart; i += 1) {
    const raw = lines[i]!;
    const lineCr = raw.endsWith('\r') ? '\r' : '';
    const body = lineCr ? raw.slice(0, -1) : raw;
    const match = assignRe.exec(body);
    if (match) {
      lines[i] = `${match[1]}${encodedValue}${match[3]}${lineCr}`;
      return lines.join('\n');
    }
  }

  // 2) Ключа нет → вставляем сразу после последней строки-присваивания корня (рядом
  //    с прочими корневыми скалярами), чтобы не отрывать комментарий у первой
  //    таблицы. Если корневых присваиваний нет — перед первой таблицей, минуя
  //    хвостовые пустые строки.
  const rootAssignRe = /^\s*(?:[A-Za-z0-9_-]+|"[^"]*")\s*=/;
  let insertAt = -1;
  for (let i = 0; i < tableStart; i += 1) {
    if (rootAssignRe.test(lines[i]!.replace(/\r$/, ''))) insertAt = i + 1;
  }
  if (insertAt === -1) {
    insertAt = tableStart;
    while (insertAt > 0 && lines[insertAt - 1]!.replace(/\r$/, '').trim() === '') insertAt -= 1;
  }
  lines.splice(insertAt, 0, `${key} = ${encodedValue}${cr}`);
  return lines.join('\n');
}

export function spliceCodexTableRegion(original: string, block: string, prefix: string): string {
  const lines = original.split('\n');
  // Стиль переводов строк ФАЙЛА. Генератор TOML отдаёт блок с LF; вставить его как
  // есть в CRLF-конфиг — значит намешать окончания строк. Приводим блок (и нашу
  // строку-разделитель) к стилю файла; строки вне региона не трогаем вообще —
  // их `\r` уцелел при split('\n') и вернётся при join.
  const eol = detectEol(original);
  const cr = eol === '\r\n' ? '\r' : '';

  /** Ключ таблицы из строки-заголовка `[key]` / `[[key]]`, иначе undefined. */
  const tableKeyOf = (line: string): string | undefined => {
    const trimmed = line.replace(/\r$/, '').trimStart();
    if (!trimmed.startsWith('[')) return undefined;
    const match = trimmed.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/);
    return match ? match[1] : undefined;
  };

  const isPrefixKey = (key: string): boolean => key === prefix || key.startsWith(`${prefix}.`);

  const headerIdx: number[] = [];
  lines.forEach((line, idx) => {
    const key = tableKeyOf(line);
    if (key !== undefined && isPrefixKey(key)) headerIdx.push(idx);
  });

  const blockLines = block
    ? blockToEol(block, '\n')
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => `${line}${cr}`)
    : [];

  if (headerIdx.length === 0) {
    // Регион отсутствует. Убедимся, что префикс не задан dotted/inline-ключом на
    // верхнем уровне — иначе добавленный блок конфликтует с ним (fail-closed).
    const inlineRe = new RegExp(`^\\s*(${prefix}|"${prefix}")\\s*[.=]`);
    for (const line of lines) {
      if (tableKeyOf(line) !== undefined) continue;
      if (inlineRe.test(line.replace(/\r$/, ''))) throw new UnrecognizedFormatError();
    }
    if (blockLines.length === 0) return original;
    const trimmed = original.replace(/(?:\r?\n)+$/, '');
    // Строки блока уже несут свой `\r` (если файл в CRLF), поэтому склейка и
    // хвост — всегда через `\n`: иначе получился бы двойной `\r`.
    return `${trimmed}${eol}${eol}${blockLines.join('\n')}\n`;
  }

  const start = headerIdx[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const key = tableKeyOf(lines[i]!);
    if (key !== undefined && !isPrefixKey(key)) {
      end = i;
      break;
    }
  }

  // Не поглощать хвостовые пустые строки и комментарии, прилегающие к следующей
  // секции: они, как правило, относятся к ней (комментарий над `[mcp_servers.x]`
  // описывает именно её). Сдвигаем конец региона выше них — так они остаются
  // байт-в-байт за пределами перегенерированного блока. Заголовки при этом не
  // пересекаются (мы шагаем только по blank/`#`), поэтому проверка непрерывности
  // ниже остаётся корректной.
  while (end > start + 1) {
    const prev = lines[end - 1]!.replace(/\r$/, '').trim();
    if (prev === '' || prev.startsWith('#')) end -= 1;
    else break;
  }

  // Непрерывность: все заголовки префикса обязаны лежать внутри [start, end).
  if (headerIdx.some((idx) => idx >= end)) throw new UnrecognizedFormatError();

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  // Отделяем блок от следующей секции ровно одной пустой строкой — но только если
  // впереди есть контент и он не начинается с пустой строки (её мы уже сохранили,
  // выведя из региона выше). Иначе получили бы двойной перевод строки.
  const afterHasContent = after.some((line) => line.trim() !== '');
  const afterStartsBlank = after.length > 0 && after[0]!.replace(/\r$/, '').trim() === '';
  const separator = blockLines.length > 0 && afterHasContent && !afterStartsBlank ? [cr] : [];
  const merged = [...before, ...blockLines, ...separator, ...after];
  return merged.join('\n');
}
