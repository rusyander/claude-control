import type { LimitFact, StepClass, WindowDecision } from '@agentdeck/contracts/core/economy';
import type { LimitKind } from '@agentdeck/contracts/core/routes';

/**
 * `economy/window` — ЕДИНСТВЕННЫЙ судья окна (03 §Economy, 11 §Economy, R:S2-08a, P19, P115).
 * Таблица «вид предела × класс шага»:
 *
 * | вердикт   | когда                                         | ждут                          |
 * |-----------|-----------------------------------------------|-------------------------------|
 * | open      | фактов нет / доля < 90 % / сброс прошёл         | никто                         |
 * | warn      | CLI предупредил, доля < 90 %                     | никто (P19)                   |
 * | held      | доля ≥ 90 % (window, rate, budget, slot)         | work, review, background      |
 * | refused   | настоящий отказ (window, rate 429, slot занят)   | все сессии маршрута до сброса |
 * | exhausted | отказ бюджета (402)                              | все сессии; снимает человек   |
 * | offline   | сеть до маршрута (P116, вердикт ставит проводка) | все сессии маршрута           |
 *
 * `fix`, `final-gate`, `publish` не ОТКЛАДЫВАЮТСЯ никогда (`defer` их не несёт): тесное окно
 * не мешает доделать начатое. Отказ — другое: маршрут не обслуживает, сессия `fix` на нём
 * ждёт сброса (держит только сессии ЭТОГО маршрута — остальные маршруты идут, P115);
 * `final-gate` и `publish` модели не зовут и окна не ждут вовсе.
 */

/** Порог отложения (03:157): с этой доли окна новые work/review/background на маршруте ждут. */
export const DEFER_AT_PCT = 90;

/** Что откладывает тесное окно; фикс, финальные ворота и публикация — никогда. */
export const DEFERRABLE: readonly StepClass[] = ['work', 'review', 'background'];

/** Классы, у которых есть сессия модели на маршруте (отказ держит их). */
const SESSION_CLASSES: readonly StepClass[] = ['work', 'review', 'background', 'fix'];

/** Последний факт пары «маршрут × вид»: новый факт (в том числе снятие отказа) заменяет старый. */
function latest(
  facts: readonly LimitFact[],
  routeId: string,
  limitKind: LimitKind,
): LimitFact | undefined {
  let best: LimitFact | undefined;
  for (const f of facts) {
    if (f.routeId !== routeId || f.limitKind !== limitKind) continue;
    if (!best || f.at >= best.at) best = f;
  }
  return best;
}

const decision = (
  routeId: string,
  limitKind: LimitKind,
  verdict: WindowDecision['verdict'],
  defer: readonly StepClass[],
  resumeAt: number | null,
  reasons: string[],
): WindowDecision => ({ routeId, limitKind, verdict, defer: [...defer], resumeAt, reasons });

/**
 * Вердикт одной пары «маршрут × вид предела» на момент `now`. Сброс прошёл — пара снова
 * открыта (P19 «reset resumes»); исчерпание бюджета сбросом не снимается — только новым фактом
 * (`clear-exhausted`, P122).
 */
export function decideWindow(
  facts: readonly LimitFact[],
  routeId: string,
  limitKind: LimitKind,
  now: number,
): WindowDecision {
  const fact = latest(facts, routeId, limitKind);
  if (!fact) return decision(routeId, limitKind, 'open', [], null, ['no-fact']);
  const pct = fact.usedPct === null ? '' : ` ${fact.usedPct}%`;
  const why = `${fact.source}${pct}`;
  if (limitKind === 'budget' && fact.refusal)
    return decision(routeId, limitKind, 'exhausted', DEFERRABLE, null, [
      `${why}: exhausted, cleared only by the human`,
    ]);
  if (fact.resetAt !== null && now >= fact.resetAt)
    return decision(routeId, limitKind, 'open', [], null, [`${why}: reset passed`]);
  if (fact.refusal)
    return decision(routeId, limitKind, 'refused', DEFERRABLE, fact.resetAt, [`${why}: refused`]);
  if (fact.usedPct !== null && fact.usedPct >= DEFER_AT_PCT)
    return decision(routeId, limitKind, 'held', DEFERRABLE, fact.resetAt, [
      `${why}: at or above ${DEFER_AT_PCT}%`,
    ]);
  if (fact.warning)
    return decision(routeId, limitKind, 'warn', [], null, [`${why}: warning holds nothing`]);
  return decision(routeId, limitKind, 'open', [], null, [why]);
}

/** Вердикты маршрута по каждому виду предела, о котором есть факт. */
export function decideRoute(
  facts: readonly LimitFact[],
  routeId: string,
  now: number,
): WindowDecision[] {
  const kinds = new Set(facts.filter((f) => f.routeId === routeId).map((f) => f.limitKind));
  return [...kinds].sort().map((kind) => decideWindow(facts, routeId, kind, now));
}

/** Ждёт ли шаг класса `cls` на маршруте с этим вердиктом (одна пара «маршрут × вид»). */
export function waitsOn(d: WindowDecision, cls: StepClass): boolean {
  switch (d.verdict) {
    case 'refused':
    case 'exhausted':
    case 'offline':
      return SESSION_CLASSES.includes(cls);
    case 'held':
      return d.defer.includes(cls);
    default:
      return false;
  }
}

/**
 * Ждёт ли шаг на маршруте по всем видам предела и до когда: `resumeAt` — самый поздний сброс
 * держащих пар; `null` при `wait` — сброса нет (исчерпание, сеть, слот): ждать факта.
 */
export function routeWait(
  decisions: readonly WindowDecision[],
  cls: StepClass,
): { wait: boolean; resumeAt: number | null; by: WindowDecision[] } {
  const by = decisions.filter((d) => waitsOn(d, cls));
  if (by.length === 0) return { wait: false, resumeAt: null, by };
  const open = by.some((d) => d.resumeAt === null);
  const resumeAt = open ? null : Math.max(...by.map((d) => d.resumeAt as number));
  return { wait: true, resumeAt, by };
}
