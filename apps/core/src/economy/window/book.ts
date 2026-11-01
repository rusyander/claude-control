import type { LimitFact, WindowDecision } from '@agentdeck/contracts/core/economy';
import { decideRoute } from './window.ts';
import type { WindowHealthRow } from './window.types.ts';

/**
 * Книга окон ядра (G7): окно маршрута общее для всех задач и сборок машины — факт, увиденный
 * одной сессией, судит шаги каждой задачи на том же маршруте. Держит последний факт на пару
 * «маршрут × вид предела»; решает по нему только `economy/window`.
 */
export class WindowBook {
  private readonly facts = new Map<string, LimitFact>();

  observe(fact: LimitFact): void {
    const key = `${fact.routeId}|${fact.limitKind}`;
    const was = this.facts.get(key);
    // Запоздалый факт (поток другой сессии отстал) новее не становится.
    if (was && was.at > fact.at) return;
    this.facts.set(key, fact);
  }

  all(): LimitFact[] {
    return [...this.facts.values()];
  }

  decide(routeId: string, now: number): WindowDecision[] {
    return decideRoute(this.all(), routeId, now);
  }

  routes(): string[] {
    return [...new Set(this.all().map((f) => f.routeId))].sort();
  }
}

/**
 * Окно для `/v1/health` (07): вердикт каждой пары, о которой есть факт. Пусто — фактов окна не
 * было (маршрут без события окна — `unknown`, а не «открыт»: это видно по отсутствию строки).
 */
export function windowHealth(book: WindowBook, now: number): { routes: WindowHealthRow[] } {
  const byKey = new Map(book.all().map((f) => [`${f.routeId}|${f.limitKind}`, f]));
  const rows = book.routes().flatMap((routeId) =>
    book.decide(routeId, now).map((d) => {
      const fact = byKey.get(`${d.routeId}|${d.limitKind}`)!;
      return {
        routeId: d.routeId,
        limitKind: d.limitKind,
        verdict: d.verdict,
        resumeAt: d.resumeAt,
        usedPct: fact.usedPct,
        observedAt: fact.at,
      };
    }),
  );
  return { routes: rows };
}
