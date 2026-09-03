import { isMap, isSeq, isScalar, type Document } from 'yaml';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { deleteYamlKey, otherYamlKeysProjection, parseYamlMapDocument } from './yaml-doc.ts';

/**
 * Round-trip-правка конфигурации Continue: `~/.continue/config.yaml` (MCP-серверы)
 * и `~/.continue/permissions.yaml` (права инструментов CLI `cn`).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО (docs.continue.dev/reference, /customize/deep-dives/mcp,
 * /cli/configuration, /cli/tool-permissions) и потому реализовано:
 *
 *  1. MCP — ключ `mcpServers` в `config.yaml`. Форма у Continue СВОЯ и отличается
 *     от всех прочих провайдеров: это не отображение «имя → запись», а СПИСОК
 *     записей, у каждой из которых имя лежит ВНУТРИ, полем `name`:
 *
 *         mcpServers:
 *           - name: My MCP Server
 *             command: uvx
 *             args: [mcp-server-sqlite, --db-path, ./test.db]
 *             cwd: /Users/NAME/project
 *             env:
 *               NODE_ENV: production
 *
 *     Транспорт задаётся полем `type`: `stdio` (по умолчанию, тогда `command` +
 *     `args`), `sse` и `streamable-http` (тогда обязателен `url`). Заголовки
 *     удалённого сервера живут в `requestOptions.headers`.
 *
 *  2. Права — отдельный файл `~/.continue/permissions.yaml` с ТРЕМЯ списками
 *     верхнего уровня: `allow` (выполнять сразу), `ask` (спрашивать), `exclude`
 *     (спрятать инструмент от агента). Элементы — строки вида `Read(*)`, `Bash`
 *     или инструмент с шаблоном путей. Режима-переключателя, как у Codex/Gemini/Qwen,
 *     у Continue НЕТ: модель прав — ровно три списка.
 *
 * ПОЧЕМУ Document API, а не `parse` + `stringify`: config.yaml пользователя —
 * живой файл с моделями, правилами и комментариями. Полная пересборка стёрла бы
 * комментарии и порядок ключей. Document API правит ДЕРЕВО: меняется только узел
 * `mcpServers` (или список прав), всё остальное остаётся как есть.
 *
 * ЧЕСТНОЕ ОГРАНИЧЕНИЕ: комментарии ВНУТРИ самого блока `mcpServers` при записи не
 * сохраняются — блок пересобирается из значений (иначе не удержать «чужие поля
 * записи целы»). Комментарии над блоком, под ним и во всех прочих ключах целы.
 * Незнакомые поля записи (`cwd`, `connectionTimeout`, `apiKey`, любые будущие)
 * переносятся ПО ЗНАЧЕНИЮ и не теряются.
 *
 * ЧЕГО ПАНЕЛЬ НЕ ДЕЛАЕТ: не трогает `~/.continue/mcpServers/*.yaml` (отдельные
 * блоки-файлы) и ключ `rules` — форматы «блоков» и inline-правил в этой фазе не
 * разбирались, а угадывать нельзя.
 *
 * FAIL-CLOSED: файл не разбирается как YAML, корень не отображение, `mcpServers`
 * не список (или запись не отображение / без строкового `name`), список прав не
 * список строк, результат не сходится с намерением при контрольном разборе → НЕ
 * пишем, бросаем `UnrecognizedFormatError` (раздел только для чтения).
 */

export { UnrecognizedFormatError };

/** Ключ MCP-серверов в `config.yaml` — СПИСОК записей с полем `name` внутри. */
export const CONTINUE_MCP_KEY = 'mcpServers';

/** Три задокументированных списка `permissions.yaml`, в порядке показа. */
export const CONTINUE_PERMISSION_KEYS = ['allow', 'ask', 'exclude'] as const;
export type ContinuePermissionKey = (typeof CONTINUE_PERMISSION_KEYS)[number];

/** Запись MCP-сервера Continue как она лежит в файле (чужие поля тоже здесь). */
export type ContinueRawServer = Record<string, unknown>;

/**
 * Разобрать конфигурацию Continue (общая основа — `lib/yaml-doc.ts`: корень
 * обязан быть отображением, ошибка разбора → fail-closed).
 */
export function parseContinueDocument(text: string): Document {
  return parseYamlMapDocument(text);
}

// --- MCP-серверы (`mcpServers` в config.yaml) --------------------------------

/**
 * Прочитать список записей `mcpServers` как есть (с чужими полями). Ключа нет →
 * пустой список. Не список, запись не отображение, отсутствующее/пустое/
 * неуникальное имя → fail-closed: форма не наша, править её вслепую нельзя.
 */
export function readContinueServers(text: string): ContinueRawServer[] {
  const doc = parseContinueDocument(text);
  const node = doc.get(CONTINUE_MCP_KEY, true);
  if (node === undefined || node === null) return [];
  if (!isSeq(node)) throw new UnrecognizedFormatError();

  const seen = new Set<string>();
  return node.items.map((item) => {
    if (!isMap(item)) throw new UnrecognizedFormatError();
    const raw = item.toJSON() as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UnrecognizedFormatError();

    const entry = raw as ContinueRawServer;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    // Имя — единственный способ адресовать запись в СПИСКЕ. Без него (или при
    // повторе) панель не смогла бы гарантировать, что правит именно ту запись.
    if (!name || seen.has(name)) throw new UnrecognizedFormatError();
    seen.add(name);
    return entry;
  });
}

/**
 * Записать желаемый набор записей `mcpServers`, СОХРАНИВ все прочие ключи файла и
 * комментарии вне блока. Пустой набор — ключ удаляется (пустой `mcpServers: []`
 * молча не пишем).
 *
 * Возвращает НОВЫЙ текст файла; сама запись — снаружи, через `safe-io` (бэкап +
 * атомарно + сохранение формы файла). Перед возвратом результат ПЕРЕПРОВЕРЯЕТСЯ:
 * он обязан разбираться, давать ровно заданный список и не менять ни одного
 * другого ключа. Не сошлось — `UnrecognizedFormatError`, файл не трогаем.
 */
export function writeContinueServers(text: string, servers: ContinueRawServer[]): string {
  // Fail-closed на ВХОДЕ: существующий блок обязан читаться нашей моделью.
  readContinueServers(text);

  const original = parseContinueDocument(text);
  const draft = parseContinueDocument(text);

  if (servers.length === 0) deleteYamlKey(draft, CONTINUE_MCP_KEY);
  else draft.set(CONTINUE_MCP_KEY, servers);

  // lineWidth: 0 — длинные аргументы и адреса не переносятся на следующую строку.
  // flowCollectionPadding: false — чужие потоковые списки (`roles: [chat, edit]`)
  // остаются в стиле документации Continue, а не превращаются в `[ chat, edit ]`.
  const next = draft.toString({ lineWidth: 0, flowCollectionPadding: false });

  const check = parseContinueDocument(next);
  if (JSON.stringify(servers) !== JSON.stringify(readContinueServers(next))) {
    throw new UnrecognizedFormatError();
  }
  if (
    otherYamlKeysProjection(original, [CONTINUE_MCP_KEY]) !==
    otherYamlKeysProjection(check, [CONTINUE_MCP_KEY])
  ) {
    throw new UnrecognizedFormatError();
  }

  return next;
}

// --- Права (`allow` / `ask` / `exclude` в permissions.yaml) ------------------

/** Значения трёх списков прав. Отсутствующий ключ = пустой список. */
export type ContinuePermissionLists = Record<ContinuePermissionKey, string[]>;

/**
 * Прочитать один список прав. Ключа нет → пусто. Одиночная строка — краткая
 * форма списка из одного правила. Всё прочее (карта, число, элемент не строка,
 * пустая строка) → fail-closed.
 */
function readPermissionList(doc: Document, key: ContinuePermissionKey): string[] {
  const node = doc.get(key, true);
  if (node === undefined || node === null) return [];

  const items = isSeq(node) ? node.items : [node];
  return items.map((item) => {
    if (!isScalar(item) || typeof item.value !== 'string') throw new UnrecognizedFormatError();
    const value = item.value.trim();
    if (!value) throw new UnrecognizedFormatError();
    return value;
  });
}

/** Прочитать все три списка `permissions.yaml`. */
export function readContinuePermissions(text: string): ContinuePermissionLists {
  const doc = parseContinueDocument(text);
  return {
    allow: readPermissionList(doc, 'allow'),
    ask: readPermissionList(doc, 'ask'),
    exclude: readPermissionList(doc, 'exclude'),
  };
}

/**
 * Ключ прав задан в файле хотя бы один — значит раздел НЕ на дефолтах CLI (даже
 * если все три списка пусты: пустой `exclude: []` пользователь написал сам).
 */
export function hasContinuePermissionKeys(text: string): boolean {
  const doc = parseContinueDocument(text);
  return CONTINUE_PERMISSION_KEYS.some((key) => doc.get(key, true) !== undefined);
}

/**
 * Записать три списка прав, СОХРАНИВ комментарии и прочие ключи файла. Пустой
 * список — ключ удаляется (значений по умолчанию панель молча не пишет).
 * Контроль до записи — как у MCP: разбор + сверка с намерением + неизменность
 * прочих ключей.
 */
export function writeContinuePermissions(text: string, lists: ContinuePermissionLists): string {
  for (const key of CONTINUE_PERMISSION_KEYS) {
    for (const rule of lists[key]) {
      // Перевод строки внутри правила сломал бы форму списка при обратном чтении.
      if (!rule.trim() || /[\r\n]/.test(rule)) throw new UnrecognizedFormatError();
    }
  }

  // Fail-closed на ВХОДЕ: существующие списки обязаны читаться нашей моделью.
  readContinuePermissions(text);

  const original = parseContinueDocument(text);
  const draft = parseContinueDocument(text);

  for (const key of CONTINUE_PERMISSION_KEYS) {
    if (lists[key].length === 0) deleteYamlKey(draft, key);
    else draft.set(key, [...lists[key]]);
  }

  const next = draft.toString({ lineWidth: 0, flowCollectionPadding: false });

  const check = parseContinueDocument(next);
  if (JSON.stringify(lists) !== JSON.stringify(readContinuePermissions(next))) {
    throw new UnrecognizedFormatError();
  }
  if (
    otherYamlKeysProjection(original, CONTINUE_PERMISSION_KEYS) !==
    otherYamlKeysProjection(check, CONTINUE_PERMISSION_KEYS)
  ) {
    throw new UnrecognizedFormatError();
  }

  return next;
}
