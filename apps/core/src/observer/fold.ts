import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { FiredVerdict, Predicate, PredicateCtx } from './observer.types.ts';
import { OBSERVER_PREDICATES } from './registry.ts';

/**
 * Свёртка наблюдателя (этап 8, F2): состояние каждого предиката по порядку реестра + ключи уже
 * вынесенных решений. Чистая, как свёртка задачи: строка журнала → новое состояние и НОВЫЕ
 * сработавшие вердикты (ключ, который уже был, второй раз не выходит — P33 «никогда дважды»).
 */
export interface ObserverFold {
  readonly states: readonly unknown[];
  readonly keys: ReadonlySet<string>;
}

export interface ObserverStep {
  state: ObserverFold;
  verdicts: FiredVerdict[];
  /** Предикат бросил на строке: его состояние не сдвинулось, прочие идут дальше. */
  errors: string[];
}

export function initObserverFold(
  predicates: readonly Predicate[] = OBSERVER_PREDICATES,
): ObserverFold {
  return { states: predicates.map((p) => p.init()), keys: new Set() };
}

/** Ключи решений, вынесенных до этой свёртки (строки `decision{class:'observer'}` журнала). */
export function withKeys(fold: ObserverFold, keys: Iterable<string>): ObserverFold {
  return { ...fold, keys: new Set([...fold.keys, ...keys]) };
}

export function foldObserver(
  fold: ObserverFold,
  line: JournalLine,
  ctx: PredicateCtx,
  predicates: readonly Predicate[] = OBSERVER_PREDICATES,
): ObserverStep {
  const states = [...fold.states];
  const fresh: FiredVerdict[] = [];
  const errors: string[] = [];
  let keys = fold.keys;
  predicates.forEach((p, i) => {
    let out: ReturnType<Predicate['step']>;
    try {
      out = p.step(states[i], line, ctx);
    } catch (e) {
      errors.push(`${p.ids.join(',')} at seq ${line.seq}: ${(e as Error).message}`);
      return;
    }
    states[i] = out.state;
    for (const v of out.verdicts) {
      if (!v.fired || keys.has(v.key)) continue;
      keys = new Set([...keys, v.key]);
      fresh.push(v);
    }
  });
  return { state: { states, keys }, verdicts: fresh, errors };
}
