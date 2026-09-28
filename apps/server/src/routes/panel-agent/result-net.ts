import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  findSecretSpans,
  isSecretFree,
  isSecretName,
  knownKeySpans,
  maskArgList,
  SECRET_MASK,
  type SecretSpan,
} from '../../lib/secret-mask.ts';

/**
 * Последняя сетка перед моделью (D8, 28.09.2026): КАЖДЫЙ результат и текст
 * отказа действия агента панели проходит её, со своей маской в `shape` или без
 * неё. Маска по месту остаётся первой — она знает форму ответа; сетка ловит то,
 * что форма забыла, и действие, которое маску не завело вовсе.
 *
 * Правила те же, что у `maskDeep`, с поправками по живым ответам (прогон всех
 * интеграционных тестов агента через сетку, 28.09):
 * - `key` — подпись записи (`{ key: 'PATH', value }` у окружения), а не секрет;
 * - `chatKey`, `jiraIssueKey`, `groupKey` — идентификаторы: без них модель не
 *   найдёт то, что только что создала; секретом их делает только значение;
 * - значение записи `{ key|name: 'API_TOKEN', value }` прячется по имени соседа;
 * - поля-пути (`projectPath`, `cwd`) не маскируются: это место на диске;
 * - массив строк — аргументы команды (`--token abc`): значение после секретного
 *   флага прячется целиком; массив под секретным именем — поимённо.
 */
export function netResult(action: string, payload: unknown): unknown {
  return APP_TEXT_ACTIONS.has(action) ? payload : maskResult(payload);
}

/** Текст отказа для модели: детектор по всей строке. */
export const netMessage = (message: string): string => maskText(message);

/**
 * Карточка — та же сетка. Её видит человек, но она лежит и в `GET /api/agent/pending`
 * и уходит в журнал. Прогон всех действий (28.09.2026) нашёл в карточках то, что
 * маска по месту пропустила: название чата с вставленным ключом в сводке пяти
 * действий чата и значение после `--api-key` строкой ниже в диффе удаления
 * MCP-сервера — построчная маска диффа флага на соседней строке не видит, детектор
 * по всему тексту видит.
 */
export const netPreview = <T>(preview: T): T => maskResult(preview) as T;

/**
 * Действия, чей ответ — тексты самого приложения (справка), а не данные
 * человека: секрету человека там взяться неоткуда (D5: справка раскрываема), а
 * детектор портил примеры («KEY=VALUE» → «KEY=••••••», «AES-256-GCM»).
 */
const APP_TEXT_ACTIONS = new Set(['read_help_topic', 'search_help', 'list_help_topics']);

export function maskResult(value: unknown, name = ''): unknown {
  if (typeof value === 'string') return maskString(value, name);
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === 'string')) {
      if (PATH_FIELD.test(name)) return value;
      return secretName(name)
        ? value.map((item: string) => maskString(item, name))
        : maskArgList(value);
    }
    return value.map((item) => maskResult(item, name));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        labelsSecretValue(record, key) && typeof item === 'string' && !isSecretFree(item)
          ? SECRET_MASK
          : maskResult(item, key),
      ]),
    );
  }
  return value;
}

/**
 * Поля-пути (`projectPath`, `cwd`, `dirs`): место на диске, а не секрет. Детектор
 * принимал за ключ последний сегмент временного каталога (`cc-agent-a4-project-uy9Xe7`),
 * и модель теряла путь проекта, по которому потом сама же фильтрует.
 */
const PATH_FIELD = /^(?:path|paths|dir|dirs|cwd|root)$|[a-z0-9](?:Path|Paths|Dir|Dirs|Root)$/;

/**
 * Поля-подписи записи: имя поля секретное, но в нём название, а не значение.
 * Решение 28.09.2026 (U0, по находке U4b: поле `key` схемы кейсов доезжало до
 * модели маской): голое `key` в ответах панели — подпись (переменная окружения,
 * поле схемы, ключ задачи трекера), поэтому ПО ИМЕНИ оно не прячется. Значение
 * под ним проходит детектор по форме: ключ вендора, JWT, непрозрачная строка —
 * прячутся. Цена решения названа: короткий «простой» пароль прямо под голым
 * `key` без подписи рядом модель увидит — такой формы в ответах панели нет.
 */
const LABEL_FIELDS = new Set(['key']);

/** Подписи записи, чьё секретное значение прячет соседнее значение. */
const ENTRY_LABELS = ['key', 'name'] as const;

/** Поля значения записи с подписью. */
const ENTRY_VALUES = new Set(['value']);

/** Поле — подпись записи (`key`): по имени не прячется, решает детектор. */
export const isLabelField = (name: string): boolean => LABEL_FIELDS.has(name);

/**
 * Поле `field` — значение записи с секретной подписью: `{ key: 'API_TOKEN',
 * value }`, `{ name: 'DB_PASSWORD', value }`. Подпись секретная — значит
 * секретно то, что она подписывает, какой бы формы оно ни было.
 */
export function labelsSecretValue(record: Record<string, unknown>, field: string): boolean {
  if (!ENTRY_VALUES.has(field)) return false;
  return ENTRY_LABELS.some((label) => {
    const labelValue = record[label];
    return typeof labelValue === 'string' && isSecretName(labelValue);
  });
}

/** camelCase `…Key` поля ответа — идентификатор записи. */
const IDENTIFIER_KEY = /^[a-z][A-Za-z0-9]*Key$/;

/** …кроме ключей, которые и есть секрет. */
const SECRET_KEY =
  /(?:api|private|secret|access|signing|encryption|license|master|client|ssh|gpg|auth)Key$/i;

function secretName(name: string): boolean {
  if (name === '' || isLabelField(name) || !isSecretName(name)) return false;
  if (IDENTIFIER_KEY.test(name) && !SECRET_KEY.test(name)) {
    return isSecretName(name.slice(0, -'Key'.length));
  }
  return true;
}

function maskString(value: string, name: string): string {
  if (isSecretFree(value) || PATH_FIELD.test(name)) return value;
  return secretName(name) ? SECRET_MASK : maskText(value);
}

/**
 * Детектор по всей строке, кроме сегментов путей на диске. Ключ известной формы
 * (префикс вендора, JWT) не прощается нигде — даже именем настоящего каталога.
 */
function maskText(text: string): string {
  const known = knownKeySpans(text);
  const spans = findSecretSpans(text).filter(
    (span) =>
      known.some((key) => key.start < span.end && span.start < key.end) ||
      !isPathSegment(text, span),
  );
  let out = text;
  for (const span of spans.reverse()) {
    out = out.slice(0, span.start) + SECRET_MASK + out.slice(span.end);
  }
  return out;
}

/** Граница слова-токена: пробел, кавычка, скобка, разделитель списка. */
const TOKEN_EDGE = /[\s"'`<>|,;()[\]{}]/;

/**
 * Сегмент пути на диске — имя каталога или файла, а не ключ; то же правило, что у
 * полей-путей выше. Детектор по форме принимал за ключ сегмент временного каталога
 * (`…\Temp\cc-agent-a4-project-Op03Ck`), и карточка показывала человеку путь проекта
 * маской (полный прогон после сетки карточек, 28.09.2026). Путь — токен от диска,
 * `\\`, `/`, `~/`, `./` или с обратной косой; адрес `scheme://` путём не считается:
 * сегмент адреса бывает ключом (вебхук). И только путь, который есть на диске.
 */
function isPathSegment(text: string, span: SecretSpan): boolean {
  if (!/[\\/]/.test(text[span.start - 1] ?? '')) return false;
  const after = text[span.end];
  if (after !== undefined && !TOKEN_EDGE.test(after) && !/[\\/.]/.test(after)) return false;
  let start = span.start;
  while (start > 0 && !TOKEN_EDGE.test(text[start - 1]!)) start -= 1;
  let end = span.end;
  while (end < text.length && !TOKEN_EDGE.test(text[end]!)) end += 1;
  const token = text.slice(start, end);
  if (token.includes('://')) return false;
  if (!(/^(?:[A-Za-z]:[\\/]|\\\\|~?\/|\.\.?[\\/])/.test(token) || token.includes('\\'))) {
    return false;
  }
  // Ревью U0, m1 (28.09.2026): похожесть на путь — не довод, ключ тоже бывает в строке
  // вида `C:\x\<ключ>`. Прощается только путь, который ЕСТЬ на диске, до этого сегмента.
  return onDisk(text.slice(start, span.end));
}

/** Путь (до проверяемого сегмента включительно) существует. `~/` — домашний каталог. */
function onDisk(path: string): boolean {
  const expanded = path.startsWith('~/') ? homedir() + path.slice(1) : path;
  if (!isAbsolute(expanded) && !/^\.\.?[\\/]/.test(expanded)) return false;
  try {
    return existsSync(expanded);
  } catch {
    return false;
  }
}
