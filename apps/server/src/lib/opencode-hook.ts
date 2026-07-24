import { UnrecognizedFormatError } from './codex-toml.ts';

/**
 * Хуки OpenCode — ключ `experimental.hook` в `opencode.json` (OPENCODE-3).
 *
 * ФОРМАТ (по документации OpenCode):
 *
 * ```jsonc
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "experimental": {
 *     "hook": {
 *       "file_edited": {
 *         "*.ts": [
 *           { "command": ["prettier", "--write"], "environment": { "NODE_ENV": "development" } }
 *         ]
 *       },
 *       "session_completed": [
 *         { "command": ["notify-send", "Session completed!"] }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * СОБЫТИЙ РОВНО ДВА, и оба устроены ПО-РАЗНОМУ:
 *  - `file_edited` — ОБЪЕКТ «шаблон файлов → МАССИВ действий»;
 *  - `session_completed` — просто МАССИВ действий.
 *
 * ДЕЙСТВИЕ: `command` — МАССИВ строк argv (не строка для shell: аргументы не
 * склеиваются и не интерполируются), `environment` — необязательное отображение
 * строка→строка. Других полей действия документация не знает.
 *
 * ЭКСПЕРИМЕНТ У САМОГО OPENCODE. Ключ живёт под `experimental` — это признан
 * нестабильным разделом самим OpenCode («options under active development … may
 * change or be removed without notice»). Более того, на момент реализации
 * текущая страница `opencode.ai/docs/config` хуков не упоминает вовсе, а
 * опубликованная схема `https://opencode.ai/config.json` описывает `experimental`
 * с `additionalProperties: false` и БЕЗ `hook`. Поэтому раздел честно помечен в
 * интерфейсе как экспериментальный у самого OpenCode и НЕ подаётся как
 * стабильный API; формат взят из документации хуков, а не выдуман.
 *
 * ЧТО ПАНЕЛЬ ВЕДЁТ: ровно эти два события в ровно этой форме. ВСЁ ОСТАЛЬНОЕ —
 * другие ключи внутри `experimental` (`policies`, `batch_tool`, …) и любое
 * незнакомое событие внутри `hook` — СОХРАНЯЕТСЯ по значению и показывается
 * только для чтения. Событие знакомое, но непонятой формы (действие с чужим
 * полем, `command` не массив строк) тоже уходит в «сохранённые»: переписывать
 * вслепую панель не станет (fail-closed).
 *
 * ПУСТОЙ РЕЗУЛЬТАТ УДАЛЯЕТ КЛЮЧ, а не пишет `{}`: ни `hook: {}`, ни
 * `experimental: {}` в файле не появляются.
 */

/** Задокументированные события хуков. Ровно два, добавлять «на глаз» нельзя. */
export const OPENCODE_HOOK_EVENTS = ['file_edited', 'session_completed'] as const;
export type OpencodeHookEvent = (typeof OPENCODE_HOOK_EVENTS)[number];

/** Одна пара переменной окружения действия (порядок файла сохраняется). */
export interface OpencodeHookEnvVar {
  key: string;
  value: string;
}

/** Одно действие хука: argv-массив и необязательные переменные окружения. */
export interface OpencodeHookAction {
  /** Аргументы команды по одному элементу: `["prettier", "--write"]`. */
  command: string[];
  /** Переменные окружения действия в порядке файла (может отсутствовать). */
  environment?: OpencodeHookEnvVar[];
}

/** Группа `file_edited`: шаблон файлов и его действия. */
export interface OpencodeHookPatternGroup {
  pattern: string;
  actions: OpencodeHookAction[];
}

/** Запись, которую панель не ведёт: показывается только для чтения. */
export interface OpencodeHookPreservedEntry {
  key: string;
  /** Значение в компактном JSON — только для показа (в файле оно не меняется). */
  value: string;
}

/** Разобранное состояние ключа `experimental.hook`. */
export interface OpencodeHookState {
  /** Ключ `experimental` присутствует в файле. */
  experimentalPresent: boolean;
  /** Ключ `experimental.hook` присутствует в файле. */
  present: boolean;
  /** Группы события `file_edited` в порядке файла. */
  fileEdited: OpencodeHookPatternGroup[];
  /** Действия события `session_completed` в порядке файла. */
  sessionCompleted: OpencodeHookAction[];
  /** События внутри `hook`, которые панель не ведёт (чужие или непонятой формы). */
  preservedEvents: OpencodeHookPreservedEntry[];
  /** Ключи внутри `experimental`, кроме `hook` — сохраняются как есть. */
  preservedExperimental: OpencodeHookPreservedEntry[];
}

/** Черновик: то, что панель хочет записать в оба события. */
export interface OpencodeHookDraft {
  fileEdited: OpencodeHookPatternGroup[];
  sessionCompleted: OpencodeHookAction[];
}

/** Максимальная длина показываемого значения сохранённой записи. */
const PRESERVED_VALUE_LIMIT = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Компактное значение для показа сохранённой записи (обрезается по длине). */
function describeValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > PRESERVED_VALUE_LIMIT ? `${text.slice(0, PRESERVED_VALUE_LIMIT)}…` : text;
}

/**
 * Разобрать ОДНО действие. Панель понимает ровно два поля: обязательный
 * `command` (непустой массив строк) и необязательный `environment` (отображение
 * строка→строка). ЛЮБОЕ третье поле делает действие непонятым — вернём
 * `undefined`, и всё событие уйдёт в «сохранённые» (fail-closed: чужое поле в
 * файле мы не потеряем, потому что вообще не станем это событие переписывать).
 */
function parseAction(value: unknown): OpencodeHookAction | undefined {
  if (!isPlainObject(value)) return undefined;

  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'command' && key !== 'environment')) return undefined;

  const command = value.command;
  if (!Array.isArray(command) || command.length === 0) return undefined;
  if (!command.every((item) => typeof item === 'string')) return undefined;

  const action: OpencodeHookAction = { command: command as string[] };

  if (value.environment !== undefined) {
    if (!isPlainObject(value.environment)) return undefined;
    const entries = Object.entries(value.environment);
    if (!entries.every(([, item]) => typeof item === 'string')) return undefined;
    action.environment = entries.map(([key, item]) => ({ key, value: item as string }));
  }

  return action;
}

/** Разобрать МАССИВ действий (общий хвост обоих событий). Пустой массив допустим. */
function parseActions(value: unknown): OpencodeHookAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: OpencodeHookAction[] = [];
  for (const item of value) {
    const action = parseAction(item);
    if (!action) return undefined;
    actions.push(action);
  }
  return actions;
}

/** Разобрать `file_edited`: отображение «шаблон → массив действий». */
function parseFileEdited(value: unknown): OpencodeHookPatternGroup[] | undefined {
  if (!isPlainObject(value)) return undefined;
  const groups: OpencodeHookPatternGroup[] = [];
  for (const [pattern, raw] of Object.entries(value)) {
    const actions = parseActions(raw);
    if (!actions) return undefined;
    groups.push({ pattern, actions });
  }
  return groups;
}

/**
 * Разобрать значение ключа `experimental`.
 *
 * `undefined` → раздел не задан (хуков нет, ключ панель молча не создаёт).
 * `experimental` не объект → `UnrecognizedFormatError` (fail-closed).
 * `experimental.hook` не объект → тоже fail-closed: как править — неизвестно.
 */
export function readOpencodeHook(rawExperimental: unknown): OpencodeHookState {
  const empty: OpencodeHookState = {
    experimentalPresent: false,
    present: false,
    fileEdited: [],
    sessionCompleted: [],
    preservedEvents: [],
    preservedExperimental: [],
  };

  if (rawExperimental === undefined || rawExperimental === null) return empty;
  if (!isPlainObject(rawExperimental)) throw new UnrecognizedFormatError();

  const preservedExperimental: OpencodeHookPreservedEntry[] = [];
  for (const [key, value] of Object.entries(rawExperimental)) {
    if (key !== 'hook') preservedExperimental.push({ key, value: describeValue(value) });
  }

  const rawHook = rawExperimental.hook;
  if (rawHook === undefined || rawHook === null) {
    return { ...empty, experimentalPresent: true, preservedExperimental };
  }
  if (!isPlainObject(rawHook)) throw new UnrecognizedFormatError();

  let fileEdited: OpencodeHookPatternGroup[] = [];
  let sessionCompleted: OpencodeHookAction[] = [];
  const preservedEvents: OpencodeHookPreservedEntry[] = [];

  for (const [key, value] of Object.entries(rawHook)) {
    if (key === 'file_edited') {
      const parsed = parseFileEdited(value);
      if (parsed) fileEdited = parsed;
      else preservedEvents.push({ key, value: describeValue(value) });
      continue;
    }
    if (key === 'session_completed') {
      const parsed = parseActions(value);
      if (parsed) sessionCompleted = parsed;
      else preservedEvents.push({ key, value: describeValue(value) });
      continue;
    }
    // Незнакомое событие — сохраняем по значению и показываем только для чтения.
    preservedEvents.push({ key, value: describeValue(value) });
  }

  return {
    experimentalPresent: true,
    present: true,
    fileEdited,
    sessionCompleted,
    preservedEvents,
    preservedExperimental,
  };
}

/** Имена событий внутри `hook`, которые панель НЕ ведёт (нельзя ни менять, ни удалять). */
export function preservedHookEvents(rawExperimental: unknown): Set<string> {
  return new Set(readOpencodeHook(rawExperimental).preservedEvents.map((entry) => entry.key));
}

/** Собрать JSON-значение одного действия (порядок полей — как в документации). */
function actionToJson(action: OpencodeHookAction): Record<string, unknown> {
  const value: Record<string, unknown> = { command: [...action.command] };
  if (action.environment?.length) {
    const environment: Record<string, string> = {};
    for (const pair of action.environment) environment[pair.key] = pair.value;
    value.environment = environment;
  }
  return value;
}

/**
 * Собрать новое значение ключа `experimental` из черновика хуков.
 *
 * ПРАВИЛА:
 *  - порядок ключей исходных объектов сохраняется (копия + точечные правки);
 *  - событие из черновика перезаписывается целиком; ПУСТОЕ событие УДАЛЯЕТСЯ
 *    (пользователь снял все действия — молчаливых дефолтов панель не пишет);
 *  - событие, которое панель не ведёт, остаётся нетронутым; черновик, который
 *    его называет, → fail-closed (`UnrecognizedFormatError`, маршрут 422);
 *  - прочие ключи внутри `experimental` не трогаются вовсе;
 *  - пустой `hook` удаляется, пустой `experimental` тоже → возвращается
 *    `undefined` (вызывающий удаляет ключ из конфига, а не пишет `{}`).
 */
export function applyOpencodeHook(
  rawExperimental: unknown,
  draft: OpencodeHookDraft,
): Record<string, unknown> | undefined {
  const original = rawExperimental === undefined || rawExperimental === null ? {} : rawExperimental;
  if (!isPlainObject(original)) throw new UnrecognizedFormatError();

  const rawHook = original.hook;
  if (rawHook !== undefined && rawHook !== null && !isPlainObject(rawHook)) {
    throw new UnrecognizedFormatError();
  }

  const keep = preservedHookEvents(original);
  // Черновик не имеет права называть событие, форму которого панель не поняла.
  if (keep.has('file_edited') && draft.fileEdited.length > 0) throw new UnrecognizedFormatError();
  if (keep.has('session_completed') && draft.sessionCompleted.length > 0) {
    throw new UnrecognizedFormatError();
  }

  const hook: Record<string, unknown> = isPlainObject(rawHook) ? { ...rawHook } : {};

  if (!keep.has('file_edited')) {
    if (draft.fileEdited.length > 0) {
      const map: Record<string, unknown> = {};
      for (const group of draft.fileEdited) map[group.pattern] = group.actions.map(actionToJson);
      hook.file_edited = map;
    } else {
      delete hook.file_edited;
    }
  }

  if (!keep.has('session_completed')) {
    if (draft.sessionCompleted.length > 0) {
      hook.session_completed = draft.sessionCompleted.map(actionToJson);
    } else {
      delete hook.session_completed;
    }
  }

  const experimental: Record<string, unknown> = { ...original };
  if (Object.keys(hook).length > 0) experimental.hook = hook;
  else delete experimental.hook;

  return Object.keys(experimental).length > 0 ? experimental : undefined;
}
