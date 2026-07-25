import { UnrecognizedFormatError } from './codex-toml.ts';

/**
 * Хуки Qwen Code — ключ КОРНЯ `hooks` в `settings.json` (QWEN-1).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО (docs/users/features/hooks.md) и потому реализовано:
 *
 * ```jsonc
 * {
 *   "disableAllHooks": false,
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "^Bash$",
 *         "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 5000 } ] }
 *     ]
 *   }
 * }
 * ```
 *
 * Событие → МАССИВ ГРУПП, у группы необязательный `matcher` (регулярное
 * выражение по цели события) и массив действий `hooks`. Типов действий четыре
 * (`command`, `http`, `prompt`, внутренние функции); панель ведёт РОВНО ОДИН —
 * `command`: остальные требуют своих полей (URL, белые списки, модель), и
 * править их формой «команда + таймаут» было бы подлогом.
 *
 * ТАЙМАУТ У QWEN — МИЛЛИСЕКУНДЫ (по умолчанию 60000). У Kimi те же хуки
 * измеряются секундами; единицу несёт сводка раздела, чтобы поле было подписано.
 *
 * ЧТО ПАНЕЛЬ ВЕДЁТ: группу вида «необязательный matcher + ровно одно действие
 * типа command с полями `command`/`timeout`». Всё прочее — чужие поля группы
 * (`sequential`), несколько действий, другой тип, лишние ключи действия
 * (`async`, `env`, `shell`, `name`, …) — делает ВСЁ СОБЫТИЕ целиком
 * несопровождаемым: оно сохраняется байт-в-байт и показывается только для
 * чтения. Так же поступает раздел хуков OpenCode с незнакомыми событиями:
 * частичная перезапись чужого массива теряла бы порядок и данные.
 *
 * `disableAllHooks` панель НЕ ПИШЕТ: это рубильник всего раздела, и щёлкать им
 * из редактора отдельных правил — не то, чего ждёт пользователь. Раздел лишь
 * показывает, что он включён.
 */

/** Ключ корня со списком хуков. */
export const QWEN_HOOKS_KEY = 'hooks';

/** Ключ корня «все хуки выключены» — только чтение. */
export const QWEN_DISABLE_ALL_KEY = 'disableAllHooks';

/**
 * Задокументированные события и поддержка матчера. Порядок — как в документации
 * (инструменты, сессия, субагенты, компактизация, уведомления, без матчера).
 */
export const QWEN_HOOK_EVENTS: readonly { name: string; supportsMatcher: boolean }[] = [
  { name: 'PreToolUse', supportsMatcher: true },
  { name: 'PostToolUse', supportsMatcher: true },
  { name: 'PostToolUseFailure', supportsMatcher: true },
  { name: 'PermissionRequest', supportsMatcher: true },
  { name: 'PermissionDenied', supportsMatcher: true },
  { name: 'SessionStart', supportsMatcher: true },
  { name: 'SessionEnd', supportsMatcher: true },
  { name: 'SubagentStart', supportsMatcher: true },
  { name: 'SubagentStop', supportsMatcher: true },
  { name: 'PreCompact', supportsMatcher: true },
  { name: 'PostCompact', supportsMatcher: true },
  { name: 'Notification', supportsMatcher: true },
  { name: 'UserPromptSubmit', supportsMatcher: false },
  { name: 'MessageDisplay', supportsMatcher: false },
  { name: 'Stop', supportsMatcher: false },
  { name: 'StopFailure', supportsMatcher: false },
  { name: 'TodoCreated', supportsMatcher: false },
  { name: 'TodoCompleted', supportsMatcher: false },
];

/** Таймаут действия: миллисекунды. Потолок — панельный, а не из документации. */
export const QWEN_TIMEOUT_DEFAULT = 60_000;
export const QWEN_TIMEOUT_MIN = 1;
export const QWEN_TIMEOUT_MAX = 3_600_000;

/** Поля группы, которые панель понимает. Любое другое → событие несопровождаемо. */
const GROUP_KEYS = new Set(['matcher', 'hooks']);

/** Поля действия, которые панель понимает. */
const ACTION_KEYS = new Set(['type', 'command', 'timeout']);

/** Одно правило: событие + матчер + команда + таймаут. */
export interface QwenHookRule {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

/** Событие, форму которого панель не поняла: сохраняется целиком. */
export interface QwenHookPreservedEvent {
  key: string;
  value: string;
}

/** Разобранное состояние ключа `hooks`. */
export interface QwenHookState {
  /** Ключ `hooks` в файле есть. */
  present: boolean;
  rules: QwenHookRule[];
  preservedEvents: QwenHookPreservedEvent[];
}

/** Объект (не массив, не null) — форма и `hooks`, и группы, и действия. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Строка без управляющих символов: команда, матчер. */
function isCleanString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Таймаут: целое в границах поля. */
export function isValidQwenTimeout(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= QWEN_TIMEOUT_MIN &&
    value <= QWEN_TIMEOUT_MAX
  );
}

/**
 * Разобрать ОДНУ группу события. Не наша форма → `undefined`: тогда всё событие
 * уходит в несопровождаемые.
 */
function readGroup(event: string, value: unknown): QwenHookRule | undefined {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).some((key) => !GROUP_KEYS.has(key))) return undefined;

  const actions = value.hooks;
  if (!Array.isArray(actions) || actions.length !== 1) return undefined;

  const action = actions[0];
  if (!isPlainObject(action)) return undefined;
  if (Object.keys(action).some((key) => !ACTION_KEYS.has(key))) return undefined;
  if (action.type !== 'command') return undefined;
  if (!isCleanString(action.command) || !action.command.trim()) return undefined;
  if (action.timeout !== undefined && !isValidQwenTimeout(action.timeout)) return undefined;

  const rule: QwenHookRule = { event, command: action.command };

  if (value.matcher !== undefined) {
    // Пустая строка и `*` в документации значат «любая цель» — это ровно то же,
    // что отсутствие матчера, и в интерфейсе показывается пустым полем.
    if (!isCleanString(value.matcher)) return undefined;
    if (value.matcher.trim()) rule.matcher = value.matcher;
  }
  if (action.timeout !== undefined) rule.timeout = action.timeout;

  return rule;
}

/**
 * Прочитать ключ `hooks`. Ключа нет → пусто. Значение не объект (или значение
 * события не массив) → fail-closed: чужую форму не толкуем.
 */
export function readQwenHooks(value: unknown): QwenHookState {
  if (value === undefined || value === null) {
    return { present: false, rules: [], preservedEvents: [] };
  }
  if (!isPlainObject(value)) throw new UnrecognizedFormatError();

  const rules: QwenHookRule[] = [];
  const preservedEvents: QwenHookPreservedEvent[] = [];

  const known = new Set(QWEN_HOOK_EVENTS.map((event) => event.name));

  for (const [event, raw] of Object.entries(value)) {
    // Событие вне задокументированного списка панель не ведёт даже при знакомой
    // форме группы: имя могло появиться в новой версии CLI, и «понимать» его
    // означало бы гадать. Сохраняем целиком и показываем только для чтения.
    if (!known.has(event) || !Array.isArray(raw)) {
      preservedEvents.push({ key: event, value: JSON.stringify(raw) });
      continue;
    }
    const parsed: QwenHookRule[] = [];
    let understood = true;
    for (const group of raw) {
      const rule = readGroup(event, group);
      if (!rule) {
        understood = false;
        break;
      }
      parsed.push(rule);
    }
    // Пустой массив события панель тоже ведёт: он просто исчезнет при записи.
    if (understood) rules.push(...parsed);
    else preservedEvents.push({ key: event, value: JSON.stringify(raw) });
  }

  return { present: true, rules, preservedEvents };
}

/** Собрать группу файла из правила (порядок ключей — как в документации). */
function toGroup(rule: QwenHookRule): Record<string, unknown> {
  const action: Record<string, unknown> = { type: 'command', command: rule.command };
  if (rule.timeout !== undefined) action.timeout = rule.timeout;

  const group: Record<string, unknown> = {};
  if (rule.matcher) group.matcher = rule.matcher;
  group.hooks = [action];
  return group;
}

/**
 * Собрать НОВОЕ значение ключа `hooks` из правил, сохранив несопровождаемые
 * события как есть. Пусто → `undefined`: ключ `hooks` удаляется, а не пишется
 * пустым объектом.
 *
 * Черновик, называющий несопровождаемое событие, — ошибка формата (маршрут
 * ответит 422): переписать такое событие панель не может, а молча выбросить его
 * тем более.
 */
export function applyQwenHooks(
  value: unknown,
  rules: readonly QwenHookRule[],
): Record<string, unknown> | undefined {
  const state = readQwenHooks(value);
  const preserved = new Map(state.preservedEvents.map((entry) => [entry.key, entry]));

  const managed = new Map<string, Record<string, unknown>[]>();
  for (const rule of rules) {
    if (preserved.has(rule.event)) throw new UnrecognizedFormatError();
    const list = managed.get(rule.event) ?? [];
    list.push(toGroup(rule));
    managed.set(rule.event, list);
  }

  const next: Record<string, unknown> = {};

  // Порядок ключей: сначала события, которые уже были в файле (в их порядке),
  // потом новые. Так дифф остаётся читаемым.
  const original = isPlainObject(value) ? Object.keys(value) : [];
  for (const event of original) {
    const keep = preserved.get(event);
    if (keep) {
      next[event] = JSON.parse(keep.value) as unknown;
      continue;
    }
    const groups = managed.get(event);
    if (groups) next[event] = groups;
  }
  for (const [event, groups] of managed) {
    if (!(event in next)) next[event] = groups;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}
