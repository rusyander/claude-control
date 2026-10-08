import {
  applyQwenHooks,
  readQwenHooks,
  type HookGroupsDialect,
  type QwenHookRule,
  type QwenHookState,
} from '../qwen-hook/qwen-hook.ts';

/**
 * Хуки Codex — файл `$CODEX_HOME/hooks.json` (проектный — `<проект>/.codex/hooks.json`).
 *
 * Форма задокументирована (learn.chatgpt.com/docs/hooks) и совпадает с формой Claude
 * и Qwen: ключ корня `hooks`, событие → массив групп `{ matcher, hooks: [ { type:
 * "command", command, timeout } ] }`. Поэтому разбор и сборка — те же, что у Qwen
 * (`lib/qwen-hook/qwen-hook.ts`), а здесь только словарь событий и границы таймаута.
 *
 * Сверено живым `codex app-server` (`hooks/list`, codex-cli 0.160, 07.10.2026):
 * - `timeout` — СЕКУНДЫ; без него 600, у `SessionEnd` 1. Ключ `timeoutSec` CLI
 *   молча не читает (выходит 600) — панель пишет только `timeout`;
 * - `Interrupt` с таймаутом больше 3 CLI урезает до 3 с предупреждением — панель
 *   такой не запишет, иначе человек был бы уверен в своих 30 секундах;
 * - матчер у события без матчера (`UserPromptSubmit`) CLI молча выбрасывает;
 * - незнакомое событие CLI молча пропускает.
 *
 * Свои поля действия (`commandWindows`, `statusMessage`, `async`,
 * `additionalContextLimit`) и не-командные типы панель не ведёт: событие с ними
 * сохраняется целиком и показывается только для чтения — как у Qwen.
 *
 * Хук начинает работать только после одобрения в `/hooks` внутри Codex: доверие
 * считается по отпечатку определения, и любая правка возвращает хук в «не одобрен».
 * Записать доверие сама панель не может и не должна.
 */

/** События по документации; матчер — у тех, где таблица документации называет фильтр. */
export const CODEX_HOOK_EVENTS: readonly {
  name: string;
  supportsMatcher: boolean;
  timeoutMax?: number;
  timeoutDefault?: number;
}[] = [
  { name: 'PreToolUse', supportsMatcher: true },
  { name: 'PermissionRequest', supportsMatcher: true },
  { name: 'PostToolUse', supportsMatcher: true },
  { name: 'SessionStart', supportsMatcher: true },
  { name: 'SessionEnd', supportsMatcher: true, timeoutMax: 3, timeoutDefault: 1 },
  { name: 'SubagentStart', supportsMatcher: true },
  { name: 'SubagentStop', supportsMatcher: true },
  { name: 'PreCompact', supportsMatcher: true },
  { name: 'PostCompact', supportsMatcher: true },
  { name: 'UserPromptSubmit', supportsMatcher: false },
  { name: 'Stop', supportsMatcher: false },
  { name: 'Interrupt', supportsMatcher: false, timeoutMax: 3, timeoutDefault: 1 },
];

/**
 * Остановить действие кодом выхода 2 документация называет у `PreToolUse`,
 * `UserPromptSubmit` и `Stop` (у `Stop` — «продолжить»). `PostToolUse` «блокирует»
 * уже после запуска инструмента, `PermissionRequest` отказывает только JSON-ответом —
 * их панель блокирующими не обещает: недообещать у цели — сторона строгости.
 */
export const CODEX_BLOCKING_EVENTS = ['PreToolUse', 'UserPromptSubmit', 'Stop'] as const;

/** Таймаут: секунды. Потолок 3600 — панельный, документация общего не называет. */
export const CODEX_TIMEOUT_DEFAULT = 600;
export const CODEX_TIMEOUT_MIN = 1;
export const CODEX_TIMEOUT_MAX = 3600;

export function isValidCodexTimeout(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CODEX_TIMEOUT_MIN &&
    value <= CODEX_TIMEOUT_MAX
  );
}

const CODEX_DIALECT: HookGroupsDialect = {
  events: CODEX_HOOK_EVENTS,
  isValidTimeout: isValidCodexTimeout,
};

export function readCodexHooks(value: unknown): QwenHookState {
  return readQwenHooks(value, CODEX_DIALECT);
}

export function applyCodexHooks(
  value: unknown,
  rules: readonly QwenHookRule[],
): Record<string, unknown> | undefined {
  return applyQwenHooks(value, rules, CODEX_DIALECT);
}
