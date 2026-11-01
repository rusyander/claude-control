import type { SignalDecision } from './observer.types.ts';

/**
 * Отказ хука человека (06:121-122, G-e): факт `hook.refused` из потока сессии → сигнал
 * `hook-block` (warn, `show`) — шаг идёт дальше и подстраивается, человек видит, какой хук
 * отказал какому действию. CLI не назвал хук — `unidentified user hook` + кандидаты описи по
 * matcher (R2): отказ не теряется из-за того, что имя неизвестно.
 */

export const HOOK_BLOCK_SIGNAL = 'hook-block';
export const UNIDENTIFIED_HOOK = 'unidentified user hook';
const REASON_MAX = 300;

export interface HookRefusal {
  /** Хук, как его назвал CLI; `null` — не назвал. */
  hook: string | null;
  /** Событие хука (`PreToolUse`, `UserPromptSubmit`, `Stop` …). */
  event: string;
  /** Инструмент вызова, которому отказано; `null` — отказ не о вызове (подсказка, остановка). */
  tool: string | null;
  reason: string;
  /** Хуки описи, чей matcher подходит, — когда CLI имени не дал. */
  candidates?: readonly string[];
}

export const hookSubject = (hook: string | null): string => hook ?? UNIDENTIFIED_HOOK;

/** Хук описи, как его видит поиск кандидатов: ключ, событие, matcher. */
export interface InventoryHook {
  key: string;
  event: string;
  matcher: string | null;
}

/**
 * matcher хука CLI: пусто или `*` — любой инструмент; иначе регулярное выражение по имени
 * инструмента целиком (`Edit|Write`). Неразборчивое выражение — точные имена через `|`.
 */
function matcherMatches(matcher: string | null, tool: string | null): boolean {
  if (matcher === null || matcher === '' || matcher === '*') return true;
  if (tool === null) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher.split('|').includes(tool);
  }
}

/** Кандидаты безымянного отказа (R2): хуки описи того же события, чей matcher подходит инструменту. */
export const hookCandidates = (
  hooks: readonly InventoryHook[],
  event: string,
  tool: string | null,
): string[] =>
  hooks.filter((h) => h.event === event && matcherMatches(h.matcher, tool)).map((h) => h.key);

const clip = (text: string): string =>
  text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;

/** Решение класса `hook-block`: сигнал наблюдателя со своим классом — один судья на класс (P01). */
export type HookBlockDecision = SignalDecision & { signal: typeof HOOK_BLOCK_SIGNAL };

export function judgeHookBlock(r: HookRefusal): HookBlockDecision {
  const candidates = r.hook === null ? (r.candidates ?? []) : [];
  return {
    fired: true,
    signal: HOOK_BLOCK_SIGNAL,
    severity: 'warn',
    action: 'show',
    subject: hookSubject(r.hook),
    detail: `${r.tool ?? 'no tool call'} on ${r.event}: ${clip(r.reason.trim()) || 'no reason given'}`,
    reasons: [
      r.hook === null
        ? `the CLI did not name the hook; candidates by matcher: ${candidates.join(', ') || 'none'}`
        : `user hook ${r.hook} refused on ${r.event}`,
    ],
  };
}
