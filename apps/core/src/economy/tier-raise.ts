import { autoCapRank, modelRank, rungLabel, rungUp, type RungStep } from './tier-ladder.ts';
import type { LearnedKey } from '@agentdeck/contracts/core/economy';
import type { EscalationCause, PickSource, TierInput, TierPick, TierRung } from './tier.types.ts';

/**
 * Подъёмы ступени поверх выбора `decideTier` (этап 11): эскалация после провала прошлой попытки
 * (D21) и подъём по выученному (F1). Оба шагают `rungUp` и не выше потолка автоматики — меньшего
 * из потолка задачи и `autoCeiling` переходника: Fable сама не выбирается никогда. Поле, которое
 * назвал человек, не двигается.
 */

type Matches = (pattern: string, model: string) => boolean;

function stepper(input: TierInput, pick: TierPick, matches: Matches) {
  const ladder = input.ladders?.[pick.route.adapter];
  const capRank = autoCapRank(ladder, input.ceiling);
  const lock = { model: pick.modelHuman, effort: pick.effortHuman };
  return (from: TierRung, baseEffort: string | null): RungStep =>
    rungUp(ladder, from, {
      capRank,
      matches: (m) => matches(pick.route.modelPattern, m),
      baseEffort,
      lock,
    });
}

/** Ставит ступень; источник меняется только у поля, которое сдвинулось (иначе его назвал выбор). */
function setRung(pick: TierPick, rung: TierRung, source: PickSource): void {
  if (!pick.modelHuman && pick.model !== rung.model) {
    pick.model = rung.model;
    pick.modelSource = source;
  }
  if (!pick.effortHuman && pick.effort !== rung.effort) {
    pick.effort = rung.effort;
    pick.effortSource = source;
  }
}

/**
 * Подъём по обучению (F1): `rungs` ступеней от выбора уровня — по одной за окно, не выше потолка.
 * При эскалации не применяется: прошлая попытка уже шла на поднятой ступени.
 */
export function applyPromotion(
  input: TierInput,
  pick: TierPick,
  key: LearnedKey | null,
  reasons: string[],
  matches: Matches,
): { rungs: number; evidence: string[] } | null {
  if (input.escalation || !input.learnedRaise || key === null) return null;
  if (pick.modelHuman && pick.effortHuman) return null;
  const raise = input.learnedRaise({ key, class: input.taskClass ?? null });
  if (!raise || raise.rungs <= 0) return null;
  const up = stepper(input, pick, matches);
  const base = pick.effort;
  let rung: TierRung = { model: pick.model, effort: pick.effort };
  let done = 0;
  let stop: string | null = null;
  for (let i = 0; i < raise.rungs; i += 1) {
    const step = up(rung, base);
    if (step.atCeiling) {
      stop = step.reason;
      break;
    }
    rung = step.rung;
    done += 1;
  }
  const ids = raise.evidence.join(', ');
  if (done > 0) {
    const from = rungLabel({ model: pick.model, effort: pick.effort });
    setRung(pick, rung, 'learned-promotion');
    reasons.push(`learned promotion +${done}: ${from} → ${rungLabel(rung)} (samples ${ids})`);
  }
  if (stop !== null) reasons.push(`learned promotion stopped: ${stop}`);
  return { rungs: done, evidence: [...raise.evidence] };
}

/**
 * Эскалация (D21): прошлая попытка того же шага провалилась (красная проверка или пониженная
 * модель) — эта идёт на ступень выше той, на которой шла прошлая; на потолке — та же ступень,
 * названная «потолок». Причина несёт запись вывода проверки — из неё вводная берёт отрывок (F).
 */
export function applyEscalation(
  input: TierInput,
  pick: TierPick,
  reasons: string[],
  matches: Matches,
): { cause: EscalationCause; atCeiling: boolean } | null {
  const esc = input.escalation;
  if (!esc) return null;
  const cause = esc.cause;
  const at = `${cause.why} of step ${cause.stepId} (seq ${cause.seq}${cause.recordId ? `, record ${cause.recordId}` : ''})`;
  const from: TierRung = {
    model: pick.modelHuman ? pick.model : esc.from.model,
    effort: pick.effortHuman ? pick.effort : esc.from.effort,
  };
  // Прошлая попытка шла выше потолка автоматики и выше базового выбора — значит, её модель назвал
  // человек для ТОЙ попытки (правка шага). Эта попытка без правки: шаг вверх — от базового
  // выбора, иначе ядро само держало бы модель выше min(потолок задачи, autoCeiling) (P138).
  const ladder = input.ladders?.[pick.route.adapter];
  const fromRank = modelRank(ladder, from.model);
  const limit = Math.max(
    autoCapRank(ladder, input.ceiling) ?? -1,
    modelRank(ladder, pick.model) ?? -1,
  );
  if (!pick.modelHuman && fromRank !== null && fromRank > limit) {
    reasons.push(
      `escalation after ${at}: ${from.model} is above the auto ceiling and is not this attempt's human pick — steps from ${pick.model ?? 'cli default'}`,
    );
    from.model = pick.model;
  }
  if (from.model !== null && !matches(pick.route.modelPattern, from.model)) {
    reasons.push(
      `escalation after ${at}: ${from.model} is outside ${pick.route.modelPattern}, base pick kept`,
    );
    return { cause, atCeiling: false };
  }
  const step = stepper(input, pick, matches)(from, pick.effort);
  setRung(pick, step.rung, 'escalation');
  reasons.push(
    step.atCeiling
      ? `escalation after ${at}: retried at ${rungLabel(step.rung)}, ${step.reason}`
      : `escalation after ${at}: ${rungLabel(from)} → ${rungLabel(step.rung)}`,
  );
  return { cause, atCeiling: step.atCeiling };
}

/** Что вышло из уровня после подъёмов: модель ниже базовой — понижено, иначе потолок. */
export function settleApplied(input: TierInput, pick: TierPick, baseModel: string | null): void {
  if (pick.applied === 'raised') return;
  const ladder = input.ladders?.[pick.route.adapter];
  const now = modelRank(ladder, pick.model);
  const base = modelRank(ladder, baseModel);
  if (now === null || base === null) return;
  pick.applied = now < base ? 'lowered' : 'ceiling';
}
