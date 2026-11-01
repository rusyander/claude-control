import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate } from '../observer.types.ts';

export const WINDOW_SIGNAL = 'window';

type Verdict = JournalLine<'window.state'>['data']['verdict'];

/** Последний вердикт по паре (маршрут, вид предела); пары нет — окно было открыто. */
export type WindowFold = Readonly<Record<string, Verdict>>;

/** Вердикты, которые держат работу на маршруте (03:157): они судятся второй ступенью каталога. */
const HOLDING: ReadonlySet<Verdict> = new Set(['refused', 'held', 'exhausted', 'offline']);

/**
 * Окно маршрута (06:140, F11): сигнал на ПЕРЕХОД вердикта пары (маршрут, вид предела), а не на
 * строку — `window.state` пишется и при сдвиге одного срока сброса, и тогда человеку нечего
 * нового показать. Переход в `warn` — первая ступень каталога (`info`), в держащий вердикт —
 * вторая (`warn`, `escalated`); возврат в `open` молчит: маршрут снова работает, это не тревога.
 * Решение о работе выносит судья окна (`economy/window`), здесь — только видимость перехода.
 */
export const windowTransition: Predicate<WindowFold> = {
  ids: [WINDOW_SIGNAL],
  init: () => ({}),
  step(state, line) {
    if (line.kind !== 'window.state') return { state, verdicts: [] };
    const { routeId, limitKind, verdict, resetAt } = (line as JournalLine<'window.state'>).data;
    const pair = `${routeId}\u0000${limitKind}`;
    const was = Object.hasOwn(state, pair) ? state[pair] : 'open';
    const next = { ...state, [pair]: verdict };
    if (was === verdict || verdict === 'open') return { state: next, verdicts: [] };
    const reset = resetAt === null ? '' : `, resets at ${new Date(resetAt).toISOString()}`;
    return {
      state: next,
      verdicts: [
        {
          fired: true,
          signal: WINDOW_SIGNAL,
          subject: routeId,
          detail: `${limitKind}: ${was} → ${verdict}${reset}`,
          reasons: [`route ${routeId} ${limitKind} window moved ${was} → ${verdict}`],
          key: `${WINDOW_SIGNAL}:${routeId}:${limitKind}:${line.seq}`,
          escalated: HOLDING.has(verdict),
          ...(line.stepId ? { stepId: line.stepId } : {}),
          ...(line.sessionId ? { sessionId: line.sessionId } : {}),
        },
      ],
    };
  },
};
