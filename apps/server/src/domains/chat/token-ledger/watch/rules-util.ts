import type { GroupSignalSeverity } from '@agentdeck/contracts/group-watch';
import type { RuleHit, WatchContext, WatchNode, WatchScope, WatchState } from './watch.types.ts';

/**
 * Общее у правил сторожа (`rules.ts`) и правил пробелов покрытия (`rules-incidents.ts`):
 * срок правила-события, обрезка строк, открытый вопрос. Отдельно — чтобы модули
 * правил не импортировали друг друга по кругу.
 */

/** Сколько правило-событие остаётся активным после последнего повода. */
export const EVENT_HOLD_MS = 30 * 60_000;
export const MINUTE_MS = 60_000;

export const minutes = (ms: number): number => Math.round(ms / 60_000);
export const clip = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Правило: попадание или ничего. Важность — базовая из `GROUP_WATCH_SEVERITY`, если
 * правило не подняло её само (`severity`: вопрос висит дольше `askAlertMinutes`).
 */
export type Rule = (
  state: WatchState,
  node: WatchNode,
  ctx: WatchContext,
  now: number,
  scope: WatchScope,
) => (Omit<RuleHit, 'rule' | 'severity'> & { severity?: GroupSignalSeverity }) | undefined;

/** Свежие поводы правила-события. */
export const recent = <T extends { at: number }>(list: readonly T[], now: number): T[] =>
  list.filter((item) => now - item.at <= EVENT_HOLD_MS);

/** Поводы в окне `[now - span, now]`. */
export const within = <T extends { at: number }>(
  list: readonly T[],
  now: number,
  spanMs: number,
): T[] => list.filter((item) => item.at <= now && now - item.at <= spanMs);

export function openAsk(
  state: WatchState,
  node: WatchNode,
): { since: number; question?: string } | undefined {
  if (node.ask) return node.ask;
  const tool = Object.values(state.openTools).find((open) => open.name === 'AskUserQuestion');
  return tool
    ? { since: tool.startedAt, ...(tool.question ? { question: tool.question } : {}) }
    : undefined;
}
