import { stringify as stringifyToml } from 'smol-toml';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  spliceCodexTableRegion,
  stableToml,
} from './codex-toml.ts';

/**
 * Хуки Kimi Code — МАССИВ ТАБЛИЦ `[[hooks]]` в `config.toml` (KIMI-1).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *
 * ```toml
 * [[hooks]]
 * event   = "Notification"
 * matcher = "task\\.completed"
 * command = "terminal-notifier -title Kimi -message 'Task done'"
 * timeout = 5
 * ```
 *
 * Полей ровно четыре: `event` (обязательное, из закрытого списка),
 * `matcher` (регулярное выражение по цели события; нет — значит «любая»),
 * `command` (команда оболочки, обязательная), `timeout` (СЕКУНДЫ, 1–600, по
 * умолчанию 30). У Qwen те же по смыслу хуки живут в JSON и меряют таймаут
 * миллисекундами — единицу несёт сводка раздела.
 *
 * ГДЕ ФАЙЛ: `$KIMI_CODE_HOME/config.toml`, по умолчанию `~/.kimi-code/config.toml`.
 * Проектного config.toml у Kimi нет вовсе (см. `lib/kimi-toml.ts`), поэтому и
 * проектных хуков не бывает.
 *
 * FAIL-CLOSED, а не «допишем как поймём»: `hooks` не массив, запись не таблица,
 * у записи чужое поле, событие вне списка, пустая команда, таймаут вне границ —
 * весь раздел уходит в режим только для чтения. Регенерировать такой блок значило
 * бы потерять чужие данные. Плагины Kimi объявляют такие же правила в своём
 * манифесте — панель их не касается: они лежат в файле плагина, а не здесь.
 *
 * ЗАПИСЬ ХИРУРГИЧЕСКАЯ: заменяется непрерывный регион таблиц `[[hooks]]`
 * (`spliceCodexTableRegion`), всё вне его — включая комментарии и порядок
 * ключей — остаётся байт-в-байт. Пустой список УДАЛЯЕТ регион.
 */

/** Имя региона таблиц со списком хуков. */
export const KIMI_HOOKS_KEY = 'hooks';

/** Поля правила, которые ведёт панель. Любое другое → fail-closed. */
const RULE_KEYS = ['event', 'matcher', 'command', 'timeout'];

/**
 * Задокументированные события. Первые три умеют ЗАБЛОКИРОВАТЬ действие (код
 * выхода 2), остальные — наблюдение. Матчер поддерживают все.
 */
export const KIMI_BLOCKING_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'Stop'] as const;

export const KIMI_HOOK_EVENTS = [
  ...KIMI_BLOCKING_EVENTS,
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'StopFailure',
  'Interrupt',
  'PreCompact',
  'PostCompact',
  'Notification',
] as const;

/** Таймаут правила: секунды, задокументированные границы и значение по умолчанию. */
export const KIMI_TIMEOUT_DEFAULT = 30;
export const KIMI_TIMEOUT_MIN = 1;
export const KIMI_TIMEOUT_MAX = 600;

export interface KimiHookRule {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

/** Таймаут: целое в задокументированных границах. */
export function isValidKimiTimeout(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= KIMI_TIMEOUT_MIN &&
    value <= KIMI_TIMEOUT_MAX
  );
}

/**
 * Прочитать список правил. Ключа нет → пусто. Любое отклонение от
 * задокументированной формы → fail-closed.
 */
export function readKimiHooks(text: string): KimiHookRule[] {
  if (!text.trim()) return [];
  const hooks = parseCodexToml(text)[KIMI_HOOKS_KEY];
  if (hooks === undefined || hooks === null) return [];
  if (!Array.isArray(hooks)) throw new UnrecognizedFormatError();

  return hooks.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new UnrecognizedFormatError();
    }
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !RULE_KEYS.includes(key))) {
      throw new UnrecognizedFormatError();
    }

    const { event, matcher, command, timeout } = raw;
    if (typeof event !== 'string' || !(KIMI_HOOK_EVENTS as readonly string[]).includes(event)) {
      throw new UnrecognizedFormatError();
    }
    if (typeof command !== 'string' || !command.trim()) throw new UnrecognizedFormatError();
    if (matcher !== undefined && (typeof matcher !== 'string' || !matcher.trim())) {
      throw new UnrecognizedFormatError();
    }
    if (timeout !== undefined && !isValidKimiTimeout(timeout)) throw new UnrecognizedFormatError();

    const rule: KimiHookRule = { event, command };
    if (typeof matcher === 'string') rule.matcher = matcher;
    if (timeout !== undefined) rule.timeout = timeout as number;
    return rule;
  });
}

/** Проекция всех ключей, кроме `hooks`, — для сверки «чужое не тронуто». */
function otherKeysProjection(text: string): string {
  if (!text.trim()) return stableToml({});
  const parsed = { ...parseCodexToml(text) };
  delete parsed[KIMI_HOOKS_KEY];
  return stableToml(parsed);
}

/** Правило в форму файла: порядок полей — как в документации. */
function toEntry(rule: KimiHookRule): Record<string, unknown> {
  const entry: Record<string, unknown> = { event: rule.event };
  if (rule.matcher) entry.matcher = rule.matcher;
  entry.command = rule.command;
  if (rule.timeout !== undefined) entry.timeout = rule.timeout;
  return entry;
}

/**
 * Записать правила, сохранив остальной файл. Возвращает НОВЫЙ текст; сама запись
 * — снаружи, через `safe-io` (копия + атомарно). Пустой список УДАЛЯЕТ регион
 * `[[hooks]]`, а не пишет пустой массив.
 */
export function writeKimiHooks(text: string, rules: readonly KimiHookRule[]): string {
  for (const rule of rules) {
    if (!(KIMI_HOOK_EVENTS as readonly string[]).includes(rule.event)) {
      throw new UnrecognizedFormatError();
    }
    if (!rule.command.trim()) throw new UnrecognizedFormatError();
    if (rule.matcher !== undefined && !rule.matcher.trim()) throw new UnrecognizedFormatError();
    if (rule.timeout !== undefined && !isValidKimiTimeout(rule.timeout)) {
      throw new UnrecognizedFormatError();
    }
  }

  // Fail-closed на ВХОДЕ: то, что уже лежит в файле, обязано читаться нашей моделью.
  readKimiHooks(text);

  const intent = rules.map(toEntry);
  const block = intent.length > 0 ? stringifyToml({ [KIMI_HOOKS_KEY]: intent }) : '';

  const next = !text.trim()
    ? intent.length > 0
      ? `${stringifyToml({ [KIMI_HOOKS_KEY]: intent }).replace(/\n+$/, '')}\n`
      : ''
    : spliceCodexTableRegion(text, block, KIMI_HOOKS_KEY);

  // Верификация: репарс + совпадение с намерением + неизменность прочих ключей.
  if (stableToml(readKimiHooks(next)) !== stableToml(rules)) throw new UnrecognizedFormatError();
  if (otherKeysProjection(next) !== otherKeysProjection(text)) {
    throw new UnrecognizedFormatError();
  }

  return next;
}
