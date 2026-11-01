import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { CONTEXT_FRESH_SHARE } from '../../lib/context-share.ts';
import type { Predicate } from '../observer.types.ts';

export const CONTEXT_GROWTH_SIGNAL = 'context-growth';

export interface ContextGrowthFold {
  /** Шаг каждой сессии (из `session.started`): решение и сигнал пишутся на шаг сессии. */
  readonly steps: Readonly<Record<string, string>>;
  /**
   * Сессии, по которым сигнал уже вышел, и их продолжения (`resumeOf`): разговор, которому пауза
   * не помогла (продолжен тем же контекстом), второй раз не паркуется — иначе пауза по кругу.
   */
  readonly done: readonly string[];
}

/**
 * Рост контекста (06:137, F10): контекст последнего сообщения ГЛАВНОЙ сессии (вход + чтение +
 * запись кэша; строки субагента и строки-остатки не в счёт — это не размер запроса сессии) выше
 * `CONTEXT_FRESH_SHARE` окна маршрута → просьба о паузе в безопасной точке (действие из каталога);
 * дирижёр паркует сессию, следующий запуск решает `continuation` (выше 60 % окна — новая сессия).
 * Окно — маршрута из настроек, а без него — названное самой сессией (`turn.usage.contextWindow`,
 * вход CLI по подписке); не знает никто — молчит: судить не с чем. Раз на сессию.
 */
export const contextGrowth: Predicate<ContextGrowthFold> = {
  ids: [CONTEXT_GROWTH_SIGNAL],
  init: () => ({ steps: {}, done: [] }),
  step(state, line, ctx) {
    if (line.kind === 'session.started') {
      const d = (line as JournalLine<'session.started'>).data;
      const carried = d.resumeOf !== null && state.done.includes(d.resumeOf);
      return {
        state: {
          steps: { ...state.steps, [d.sessionId]: d.stepId },
          done: carried ? [...state.done, d.sessionId] : state.done,
        },
        verdicts: [],
      };
    }
    if (line.kind !== 'turn.usage') return { state, verdicts: [] };
    const u = (line as JournalLine<'turn.usage'>).data;
    if (u.subagent || u.remainder || state.done.includes(u.sessionId))
      return { state, verdicts: [] };
    const configured = ctx.windowOf(u.routeId, u.model);
    // Окно маршрута из настроек главнее; нет его (вход CLI по подписке) — окно, названное сессией.
    const window = configured ?? u.contextWindow ?? null;
    if (window === null || window <= 0) return { state, verdicts: [] };
    const source = configured === null ? 'reported by the session' : 'route setting';
    const context = u.input + u.cacheRead + u.cacheWrite;
    const limit = CONTEXT_FRESH_SHARE * window;
    if (context <= limit) return { state, verdicts: [] };
    const stepId = Object.hasOwn(state.steps, u.sessionId) ? state.steps[u.sessionId] : undefined;
    const pct = Math.round((context / window) * 100);
    return {
      state: { ...state, done: [...state.done, u.sessionId] },
      verdicts: [
        {
          fired: true,
          signal: CONTEXT_GROWTH_SIGNAL,
          subject: u.sessionId,
          detail: `context ${context} tokens = ${pct}% of window ${window} on ${u.routeId} (limit ${CONTEXT_FRESH_SHARE * 100}%)`,
          reasons: [
            `main-session context ${context} > ${CONTEXT_FRESH_SHARE} × window ${window} (message ${u.messageId})`,
            `window source: ${source}`,
          ],
          key: `${CONTEXT_GROWTH_SIGNAL}:${u.sessionId}`,
          sessionId: u.sessionId,
          ...(stepId ? { stepId } : {}),
          inputs: [line.seq],
        },
      ],
    };
  },
};
