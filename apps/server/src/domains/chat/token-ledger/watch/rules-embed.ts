import { BG_STALE_MS } from './reduce-embed.ts';
import { clip, MINUTE_MS, minutes, recent, type Rule } from './rules-util.ts';
import type { RuleHit, WatchContext, WatchState } from './watch.types.ts';

/**
 * Правила, перенесённые из внешнего сторожа 27.10 (`watchdog-embed-design`): R16 в двух
 * новых видах (вызов шёл долго, фон открыт долго), R37 — длинная вводная хода, R44 —
 * признание пропуска в итоге хода. Все — сведения: сторож называет, человек решает.
 */

type Body = Omit<RuleHit, 'rule' | 'severity'>;

/**
 * R16 «фон долго»: фоновая задача без уведомления о конце дольше `bgLongMinutes`. Дольше
 * двух часов — забытая запись (уведомление потерялось), а не работа: молчим.
 */
export function longBackground(
  state: WatchState,
  ctx: WatchContext,
  now: number,
): Body | undefined {
  const longMs = ctx.settings.bgLongMinutes * MINUTE_MS;
  const oldest = Object.values(state.bgTasks ?? {})
    .filter((task) => now - task.at >= longMs && now - task.at < BG_STALE_MS)
    .sort((a, b) => a.at - b.at)[0];
  if (!oldest) return undefined;
  return {
    numbers: { openMin: minutes(now - oldest.at) },
    params: { call: clip(oldest.label) },
    since: oldest.at,
    textKey: 'groupWatch.rule.R16bg',
  };
}

/**
 * R16 «шёл долго»: вызов уже кончился, но шёл дольше `slowSeconds` и вдвое дольше опыта
 * своей очереди (`noteEmbedResult`). Событие — держится полчаса.
 */
export function slowCall(state: WatchState, now: number): Body | undefined {
  const calls = recent(state.slowCalls ?? [], now);
  const last = calls.at(-1);
  if (!last) return undefined;
  return {
    numbers: {
      ranMin: Math.max(1, minutes(last.ranMs)),
      ...(last.expectMs !== undefined ? { expectMin: Math.max(1, minutes(last.expectMs)) } : {}),
      calls: calls.length,
    },
    params: { call: clip(last.label) },
    since: last.at,
    // Опыта очереди ещё нет — строка без «обычно»: подстановка без числа показала бы {{expectMin}}.
    textKey:
      last.expectMs !== undefined ? 'groupWatch.rule.R16slowExpect' : 'groupWatch.rule.R16slow',
  };
}

/**
 * R19 «вырос посреди сессии» (CTX+ внешнего сторожа): окно последнего вызова сессии выше
 * базы роста (`growthBase`: первый увиденный вызов, после сжатия — первый за ним) на
 * `contextGrowthTokens` — каждый следующий вызов несёт этот прирост заново. Сжатие
 * закрывает строку и начинает счёт заново. Начало — первый вызов последнего непрерывного
 * отрезка выше порога.
 */
export function contextGrowth(state: WatchState, ctx: WatchContext): Body | undefined {
  const first = state.growthBase;
  const last = state.calls.at(-1);
  if (first === undefined || !last) return undefined;
  const over = (call: { ctx: number }): boolean =>
    call.ctx - first >= ctx.settings.contextGrowthTokens;
  if (!over(last)) return undefined;
  let since = last.t;
  for (let i = state.calls.length - 1; i >= 0; i -= 1) {
    const call = state.calls[i];
    if (!call || !over(call)) break;
    since = call.t;
  }
  return {
    numbers: {
      growK: Math.round((last.ctx - first) / 1000),
      nowK: Math.round(last.ctx / 1000),
      firstK: Math.round(first / 1000),
    },
    since,
    textKey: 'groupWatch.rule.R19grow',
  };
}

/** Круги одного хода: повтор проверки, опрос сном, тяжёлые проверки группы, падения подряд. */
const BURN_RULES: ReadonlySet<string> = new Set(['R4', 'R11', 'R21', 'R24']);

/**
 * BURN (внешний сторож, core.mjs:452): два разных круга в одном ходе — ход жжёт окно впустую,
 * и это уже тревога. Новее из них поднимается до `alert` на месте, без нового правила;
 * круги разных ходов — каждый своё «внимание». Меняет попадания на месте.
 */
export function escalateBurn(hits: RuleHit[], turnAt: number | undefined): void {
  if (turnAt === undefined) return;
  const inTurn = hits.filter((hit) => BURN_RULES.has(hit.rule) && hit.since >= turnAt);
  if (inTurn.length < 2) return;
  const newest = inTurn.reduce((last, hit) => (hit.since >= last.since ? hit : last));
  newest.severity = 'alert';
}

export const EMBED_RULES = {
  /** R37 — вводная хода длиннее `briefChars`: каждый ход звена несёт её в окне заново. */
  R37(state, _node, ctx, now) {
    const briefs = recent(state.briefs ?? [], now);
    const last = briefs.at(-1);
    if (!last) return undefined;
    return {
      numbers: {
        charsK: Math.round(last.chars / 1000),
        limitK: Math.round(ctx.settings.briefChars / 1000),
      },
      since: last.at,
    };
  },

  /** R44 — итог хода признаёт пропуск («не проверено», «временно», «обход»). */
  R44(state, _node, _ctx, now) {
    const last = recent(state.admissions ?? [], now).at(-1);
    if (!last) return undefined;
    return {
      numbers: {},
      params: { phrase: clip(last.phrase, 60), excerpt: clip(last.excerpt, 200) },
      since: last.at,
    };
  },
} satisfies Record<string, Rule>;
