import type { Predicate } from '../observer.types.ts';
import { cliRefusalOf, permitRefusalOf, targetKey, whereOf, type PermitRefusal } from './facts.ts';

/**
 * Повтор отказа (06:137, F7): судья права отказал тому же действию над той же целью с тем же кодом
 * второй раз за шаг — без поднятого пункта человека (отказ с вопросом ждёт человека, это не
 * упрямство модели). Один отказ, увиденный обеими дорогами (хук ядра и сервер права), — одна
 * строка счёта по `toolUseId`; дорога без id сводится с соседней по ключу в пределах 2 с (R1).
 * Второй отказ — остановка шага. Отказы `step_done` — не отказы допуска (у них свой предел кругов).
 * Отказ самого CLI (`tool.event.denied`) — тоже отказ допуска; с отказом судьи того же вызова он
 * сводится по `toolUseId`, даже если судья поднял пункт человека.
 */

export const WASTE_REFUSAL_REPEAT = 'waste-refusal-repeat';

/** Окно, в котором отказ без id — тот же, что соседний того же ключа (R1). */
export const REFUSAL_SAME_MS = 2_000;

interface Seen {
  count: number;
  lastAt: number;
  lastToolUseId: string | null;
}

export interface RefusalRepeatState {
  byKey: ReadonlyMap<string, Seen>;
  toolUseIds: ReadonlySet<string>;
}

const keyOf = (r: PermitRefusal): string =>
  `${r.stepId}|${r.action}|${targetKey(r.target)}|${r.code}`;

export const refusalRepeatPredicate: Predicate<RefusalRepeatState> = {
  ids: [WASTE_REFUSAL_REPEAT],
  init: () => ({ byKey: new Map(), toolUseIds: new Set() }),
  step(state, line) {
    const r = permitRefusalOf(line) ?? cliRefusalOf(line);
    if (!r) return { state, verdicts: [] };
    if (r.toolUseId !== null && state.toolUseIds.has(r.toolUseId)) return { state, verdicts: [] };
    const toolUseIds =
      r.toolUseId === null ? state.toolUseIds : new Set(state.toolUseIds).add(r.toolUseId);
    // Отказ с пунктом человека не счёт, но его id запомнен: отказ CLI того же вызова — он же.
    if (r.humanPoint !== null) return { state: { ...state, toolUseIds }, verdicts: [] };
    const key = keyOf(r);
    const prev = state.byKey.get(key);
    const anonymous = r.toolUseId === null || prev?.lastToolUseId === null;
    if (prev && anonymous && r.at - prev.lastAt <= REFUSAL_SAME_MS) {
      // Та же отказанная попытка с другой дороги: счёт не растёт, id запоминается.
      const seen = { ...prev, lastAt: r.at, lastToolUseId: prev.lastToolUseId ?? r.toolUseId };
      return { state: { byKey: new Map(state.byKey).set(key, seen), toolUseIds }, verdicts: [] };
    }
    const seen: Seen = { count: (prev?.count ?? 0) + 1, lastAt: r.at, lastToolUseId: r.toolUseId };
    const next = { byKey: new Map(state.byKey).set(key, seen), toolUseIds };
    if (seen.count !== 2) return { state: next, verdicts: [] };
    return {
      state: next,
      verdicts: [
        {
          fired: true,
          signal: WASTE_REFUSAL_REPEAT,
          subject: r.target,
          detail: `${r.action} refused twice in this step (${r.code}), no human point raised`,
          reasons: [`second refusal of ${r.action} ${r.target} with code ${r.code}`],
          key: `${WASTE_REFUSAL_REPEAT}:${key}`,
          ...whereOf(line),
          inputs: [line.seq],
        },
      ],
    };
  },
};
