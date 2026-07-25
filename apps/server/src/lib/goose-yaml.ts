import { isMap, isScalar, type Document } from 'yaml';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { deleteYamlKey, otherYamlKeysProjection, parseYamlMapDocument } from './yaml-doc.ts';

/**
 * Round-trip-правка конфигурации Goose (Block): ОДИН файл `config.yaml` держит и
 * расширения (они же MCP-серверы), и режим аппрувов.
 *
 * ГДЕ ФАЙЛ (задокументировано): `~/.config/goose/config.yaml` на macOS/Linux и
 * `%APPDATA%\Block\goose\config\config.yaml` на Windows — путь под Windows
 * ДРУГОЙ не только разделителями, поэтому он считается отдельно (`catalog.ts`).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *
 *  1. `extensions` — ОТОБРАЖЕНИЕ «имя → запись» (не список). Тип записи задаёт
 *     ключ `type`, и типов больше, чем MCP-серверов:
 *
 *         extensions:
 *           developer:              # ВСТРОЕННОЕ расширение самого Goose
 *             type: builtin
 *             name: developer
 *             bundled: true
 *             enabled: true
 *             timeout: 300
 *           tavily:                 # внешний MCP-сервер по stdio
 *             type: stdio
 *             name: tavily
 *             cmd: npx
 *             args: [-y, mcp-tavily-search]
 *             envs: { TAVILY_API_KEY: '...' }
 *             enabled: true
 *
 *     MCP-серверами панель считает ровно три типа: `stdio` (`cmd` + `args` +
 *     `envs`), `sse` и `streamable_http` (адрес в `uri`, у `streamable_http` ещё
 *     и `headers`). Остальные типы (`builtin`, `platform`, `frontend`,
 *     `inline_python`) — это НЕ внешние серверы: они не показываются в разделе и
 *     не правятся, а любая попытка записать поверх такой записи отклоняется —
 *     затереть `developer` пользовательским сервером нельзя.
 *
 *  2. `GOOSE_MODE` — скалярный ключ КОРНЯ (ключи настроек у Goose именуются как
 *     переменные окружения): `auto`, `approve`, `smart_approve`, `chat`.
 *
 * ЧЕГО ПАНЕЛЬ НЕ ДЕЛАЕТ: не трогает `permission.yaml` (пофайловые разрешения
 * инструментов), `secrets.yaml` и связку ключей ОС — формат первого под панель не
 * разбирался, а секреты ей вести нельзя.
 *
 * ЧЕСТНОЕ ОГРАНИЧЕНИЕ: комментарии ВНУТРИ правящейся записи расширения при
 * записи не сохраняются — запись пересобирается из значений (иначе не удержать
 * «чужие поля целы»). Комментарии над блоком, у соседних расширений и во всех
 * прочих ключах файла остаются.
 *
 * FAIL-CLOSED: файл не разбирается, корень не отображение, `extensions` не
 * отображение (или запись в нём не отображение), `GOOSE_MODE` не строка,
 * результат не сходится с намерением при контрольном разборе → НЕ пишем,
 * бросаем `UnrecognizedFormatError` (раздел только для чтения).
 */

export { UnrecognizedFormatError };

/** Ключ расширений Goose — ОТОБРАЖЕНИЕ «имя → запись». */
export const GOOSE_EXTENSIONS_KEY = 'extensions';

/** Ключ режима аппрувов — скаляр в КОРНЕ файла. */
export const GOOSE_MODE_KEY = 'GOOSE_MODE';

/** Задокументированные режимы аппрувов Goose, в порядке показа. */
export const GOOSE_MODES = ['auto', 'approve', 'smart_approve', 'chat'] as const;
export type GooseMode = (typeof GOOSE_MODES)[number];

/** Режим по умолчанию: неинтерактивные и плановые сессии Goose идут в `auto`. */
export const GOOSE_DEFAULT_MODE: GooseMode = 'auto';

/** Типы расширений, которые и есть внешние MCP-серверы. */
export const GOOSE_MCP_TYPES = ['stdio', 'sse', 'streamable_http'] as const;

/** Запись расширения как она лежит в файле (чужие поля тоже здесь). */
export type GooseRawExtension = Record<string, unknown>;

/** Разобрать `config.yaml` Goose (общая основа — `lib/yaml-doc.ts`). */
export function parseGooseDocument(text: string): Document {
  return parseYamlMapDocument(text);
}

// --- Расширения (`extensions` в config.yaml) ---------------------------------

/**
 * Прочитать ВСЕ расширения как есть, в порядке файла. Ключа нет → пусто. Не
 * отображение, запись не отображение или имя пустое → fail-closed: форма не
 * наша, править её вслепую нельзя.
 *
 * Возвращаются и встроенные (`builtin` и прочие) — вызывающий сам решает, что
 * из этого MCP-сервер; сохранять при записи нужно ВСЕ.
 */
export function readGooseExtensions(text: string): Map<string, GooseRawExtension> {
  const doc = parseGooseDocument(text);
  const node = doc.get(GOOSE_EXTENSIONS_KEY, true);
  const result = new Map<string, GooseRawExtension>();
  if (node === undefined || node === null) return result;
  if (!isMap(node)) throw new UnrecognizedFormatError();

  for (const item of node.items) {
    const key = isScalar(item.key) ? item.key.value : item.key;
    if (typeof key !== 'string' || !key.trim()) throw new UnrecognizedFormatError();
    if (!isMap(item.value)) throw new UnrecognizedFormatError();

    const raw = item.value.toJSON() as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UnrecognizedFormatError();
    // Повтор ключа YAML не допускает сам, но карту всё равно строим явно.
    result.set(key, raw as GooseRawExtension);
  }
  return result;
}

/** Это внешний MCP-сервер, а не встроенное расширение Goose? */
export function isGooseMcpExtension(raw: GooseRawExtension): boolean {
  return typeof raw.type === 'string' && (GOOSE_MCP_TYPES as readonly string[]).includes(raw.type);
}

/**
 * Записать набор расширений, СОХРАНИВ прочие ключи файла и комментарии вне
 * правящегося блока. Пустой набор — ключ удаляется (пустой `extensions: {}`
 * молча не пишем).
 *
 * Возвращает НОВЫЙ текст; сама запись — снаружи, через `safe-io` (копия +
 * атомарно + сохранение формы файла). Перед возвратом результат
 * ПЕРЕПРОВЕРЯЕТСЯ: он обязан разбираться, давать ровно заданный набор и не
 * менять ни одного другого ключа. Не сошлось — `UnrecognizedFormatError`.
 */
export function writeGooseExtensions(
  text: string,
  extensions: Map<string, GooseRawExtension>,
): string {
  // Fail-closed на ВХОДЕ: существующий блок обязан читаться нашей моделью.
  readGooseExtensions(text);

  const original = parseGooseDocument(text);
  const draft = parseGooseDocument(text);

  if (extensions.size === 0) deleteYamlKey(draft, GOOSE_EXTENSIONS_KEY);
  else draft.set(GOOSE_EXTENSIONS_KEY, Object.fromEntries(extensions));

  // lineWidth: 0 — длинные аргументы и адреса не переносятся на следующую строку.
  const next = draft.toString({ lineWidth: 0 });

  const check = parseGooseDocument(next);
  const intent = JSON.stringify(Object.fromEntries(extensions));
  if (intent !== JSON.stringify(Object.fromEntries(readGooseExtensions(next)))) {
    throw new UnrecognizedFormatError();
  }
  if (
    otherYamlKeysProjection(original, [GOOSE_EXTENSIONS_KEY]) !==
    otherYamlKeysProjection(check, [GOOSE_EXTENSIONS_KEY])
  ) {
    throw new UnrecognizedFormatError();
  }

  return next;
}

// --- Режим аппрувов (`GOOSE_MODE` в корне) -----------------------------------

/**
 * Прочитать `GOOSE_MODE`. Ключа нет → `undefined` (раздел «на дефолтах CLI»).
 * Ключ есть, но не строка → fail-closed: чужую форму не толкуем.
 */
export function readGooseMode(text: string): string | undefined {
  const doc = parseGooseDocument(text);
  const node = doc.get(GOOSE_MODE_KEY, true);
  if (node === undefined || node === null) return undefined;
  if (!isScalar(node) || typeof node.value !== 'string') throw new UnrecognizedFormatError();
  return node.value.trim();
}

/**
 * Записать `GOOSE_MODE`, сохранив комментарии и прочие ключи файла. Значение
 * обязано быть из задокументированного набора — угадывать режимы нельзя.
 */
export function writeGooseMode(text: string, mode: GooseMode): string {
  if (!(GOOSE_MODES as readonly string[]).includes(mode)) throw new UnrecognizedFormatError();

  // Fail-closed на ВХОДЕ: существующее значение обязано читаться нашей моделью.
  readGooseMode(text);

  const original = parseGooseDocument(text);
  const draft = parseGooseDocument(text);
  draft.set(GOOSE_MODE_KEY, mode);

  const next = draft.toString({ lineWidth: 0 });

  const check = parseGooseDocument(next);
  if (readGooseMode(next) !== mode) throw new UnrecognizedFormatError();
  if (
    otherYamlKeysProjection(original, [GOOSE_MODE_KEY]) !==
    otherYamlKeysProjection(check, [GOOSE_MODE_KEY])
  ) {
    throw new UnrecognizedFormatError();
  }

  return next;
}
