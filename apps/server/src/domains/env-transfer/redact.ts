import { parseDocument, visit, isScalar, isPair } from 'yaml';

/**
 * Вычистка секретов из файлов, которые едут в архив переноса.
 *
 * Пользователь выбрал перенос БЕЗ секретов: архив должен спокойно лежать в
 * облаке и в мессенджере. Целые файлы-секреты (`.credentials.json`,
 * `.mcp-secrets.env`, хранилище ключей) в архив не попадают вовсе — их
 * отсеивает `sources.ts`. Но ключ может лежать и внутри обычного конфига:
 * у Kimi это `[providers.moonshot] api_key` в `config.toml`, у MCP-сервера —
 * заголовок `Authorization`. Такие ЗНАЧЕНИЯ заменяются меткой, а имена ключей
 * попадают в чек-лист манифеста: на новой машине панель покажет, что дописать.
 *
 * Правка идёт по формату файла, чтобы не портить чужой конфиг:
 *   - JSON — разбор и обратная сборка (форматирование нормализуется, это
 *     единственный формат, где мы это допускаем: комментариев в нём нет);
 *   - YAML — Document API библиотеки `yaml`, комментарии сохраняются;
 *   - TOML и всё остальное — построчно, файл остаётся байт-в-байт кроме
 *     заменённых значений.
 *
 * Лучше лишняя замена, чем утёкший токен: `apiKeyHelper` (путь к скрипту, а не
 * секрет) тоже попадёт под замену — он назван как ключ. Это видно в манифесте,
 * и пользователь вернёт значение руками.
 */

/** Метка вместо значения. Ищется глазами и грепом на новой машине. */
export const REDACTED = '__REDACTED__';

/**
 * Имя ключа, за которым может стоять секрет. Список намеренно широкий:
 * стоимость ложного срабатывания — одно поле, которое пользователь введёт
 * заново, стоимость пропуска — утёкший токен.
 */
const SECRET_KEY = /(api[-_]?key|secret|token|password|passwd|credential|auth|bearer|private)/i;

export interface RedactionResult {
  /** Содержимое после замены. */
  text: string;
  /** Пути заменённых ключей (`providers.moonshot.api_key`) — для чек-листа. */
  keys: string[];
}

/** Похоже ли имя ключа на секрет. Отдельно — чтобы правило было одно на весь домен. */
export function isSecretKeyName(name: string): boolean {
  return SECRET_KEY.test(name);
}

/**
 * Заменяет секретные значения в тексте конфигурации. Формат выбирается по
 * расширению; неизвестное расширение обрабатывается построчно — это безопасно,
 * потому что построчная замена трогает только строки вида `ключ = значение`.
 */
export function redactSecrets(fileName: string, text: string): RedactionResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return redactJson(text);
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return redactYaml(text);
  return redactLines(text);
}

function redactJson(text: string): RedactionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Битый JSON не переписываем — построчная замена сохранит файл как есть.
    return redactLines(text);
  }

  const keys: string[] = [];
  const cleaned = walkJson(parsed, '', keys);
  return { text: `${JSON.stringify(cleaned, null, 2)}\n`, keys };
}

function walkJson(value: unknown, path: string, keys: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => walkJson(item, `${path}[${index}]`, keys));
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const full = path ? `${path}.${key}` : key;
    // Замена только скалярного значения: объект под именем `auth` — это ветка
    // конфигурации, её надо обойти, а не превратить в строку.
    if (isSecretKeyName(key) && !isRecord(nested) && !Array.isArray(nested)) {
      result[key] = REDACTED;
      keys.push(full);
      continue;
    }
    result[key] = walkJson(nested, full, keys);
  }
  return result;
}

function redactYaml(text: string): RedactionResult {
  const keys: string[] = [];
  let doc;
  try {
    doc = parseDocument(text);
    if (doc.errors.length > 0) return redactLines(text);
  } catch {
    return redactLines(text);
  }

  visit(doc, {
    Pair(_, pair, path) {
      if (!isPair(pair) || !isScalar(pair.key) || !isScalar(pair.value)) return;
      const name = String(pair.key.value);
      if (!isSecretKeyName(name)) return;
      pair.value.value = REDACTED;
      keys.push([...yamlKeyPath(path), name].join('.'));
    },
  });

  return { text: doc.toString(), keys };
}

/** Имена ключей на пути к текущей паре — чтобы чек-лист показывал `extensions.github.token`. */
function yamlKeyPath(path: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const node of path) {
    if (isPair(node) && isScalar(node.key)) names.push(String(node.key.value));
  }
  return names;
}

/**
 * Построчная замена для TOML, ini и всего неизвестного. Держит секцию (`[a.b]`)
 * в уме, чтобы чек-лист называл ключ полностью. Значение заменяется целиком,
 * включая кавычки, — так строка остаётся валидной в любом из этих форматов.
 */
function redactLines(text: string): RedactionResult {
  const keys: string[] = [];
  let section = '';

  const lines = text.split(/\r?\n/).map((line) => {
    const sectionMatch = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      return line;
    }

    const pairMatch = /^(\s*)("?)([A-Za-z0-9_.-]+)\2(\s*[:=]\s*)(.+)$/.exec(line);
    if (!pairMatch) return line;

    const [, indent, quote, name, separator, value] = pairMatch;
    // Комментарий и пустое значение не трогаем: заменять нечего.
    if (!name || !value || value.trim().startsWith('#')) return line;
    if (!isSecretKeyName(name)) return line;

    keys.push(section ? `${section}.${name}` : name);
    return `${indent}${quote}${name}${quote}${separator}"${REDACTED}"`;
  });

  return { text: lines.join('\n'), keys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
