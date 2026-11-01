import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { WindowObservation } from '../adapter.types.ts';

/**
 * Окно подписки Claude Code из потока `stream-json` (11 §Economy, P19, P115). CLI сам читает
 * заголовки `anthropic-ratelimit-unified-*` и пишет строку `rate_limit_event` (имя — факт запуска
 * `claudeRunFacts.windowEvent`). Схема — та, что разбирает панель (`domains/chat/chat-events.ts`
 * `rate_limit_info`, CLI 2.1.286): `status` allowed | allowed_warning | rejected, `resetsAt` —
 * секунды эпохи, `unifiedWindows.{five_hour,seven_day}.utilization` — доля 0..1.
 *
 * Решает не этот модуль: он только переводит строку в наблюдение, судья — `economy/window`.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Доля окна 0..1 → проценты; вне диапазона — не доверяем числу (`null`). */
function pctOf(value: unknown): number | null {
  const share = finite(value);
  if (share === null || share < 0 || share > 1.5) return null;
  return Math.round(share * 10_000) / 100;
}

const msOf = (seconds: unknown): number | null => {
  const s = finite(seconds);
  return s === null || s <= 0 ? null : s * 1000;
};

interface Window {
  name: string;
  usedPct: number;
  resetAt: number | null;
}

/** Самое тесное окно из `unifiedWindows` (окна без доли не считаются: без числа нечем судить). */
function tightest(windows: unknown): Window | null {
  if (!isObject(windows)) return null;
  let best: Window | null = null;
  for (const [name, raw] of Object.entries(windows)) {
    if (!isObject(raw)) continue;
    const usedPct = pctOf(raw.utilization);
    if (usedPct === null) continue;
    if (!best || usedPct > best.usedPct) best = { name, usedPct, resetAt: msOf(raw.resetsAt) };
  }
  return best;
}

/** Строка потока → наблюдение окна; не строка окна или без `rate_limit_info` — `undefined`. */
export function readClaudeWindow(line: Json): WindowObservation | undefined {
  if (line.type !== claudeRunFacts.windowEvent?.type) return undefined;
  const info = line.rate_limit_info;
  if (!isObject(info)) return undefined;
  const status = typeof info.status === 'string' ? info.status : '';
  const named = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  const unified = tightest(info.unifiedWindows);
  // Доля прямо в событии (новые CLI) — того окна, что названо `rateLimitType`.
  const direct = pctOf(info.utilization);
  const fromUnified = unified !== null && (direct === null || unified.usedPct >= direct);
  const refusal = status === 'rejected';
  // Сброс и имя отказа — названного окна (отказало оно); иначе — того, чья доля взята.
  const own = fromUnified && !refusal ? unified : null;
  return {
    limitKind: 'window',
    usedPct: fromUnified ? unified.usedPct : direct,
    resetAt: own?.resetAt ?? msOf(info.resetsAt) ?? unified?.resetAt ?? null,
    warning: status === 'allowed_warning',
    refusal,
    window: own ? own.name : named,
  };
}
