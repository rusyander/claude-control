import type { StepRecord, TaskFoldState, UnitRecord } from '../../journal/reduce/reduce.types.ts';
import { END_REASON } from '../next/next.types.ts';

/**
 * Единица интеграции (этап 11, W3-18b): план L/XL с ≥ 2 параллельными единицами одного
 * репозитория получает единицу роли `integrate` после всех них. Её копия — слияние голов единиц
 * (`copy/integration-base.ts`, локально, без пуша); шаги — проверка интеграции, затем ревью
 * общего диффа; своего MR нет. Ворота `integrated`: единица деления публикуется (свой MR, по
 * рёбрам) только когда её интеграция зелёная; красная — не публикуется ни одна, причина названа.
 * Конфликт голов решается в задаче: правка ветки единицы, следующий круг ворот сливает заново.
 */

export const INTEGRATION_ROLE = 'integrate';
export const INTEGRATION_UNIT_NAME = 'integration';
/** Шаги ведущего, которые идут только в единице интеграции (`scenario/presets.ts`). */
export const INTEGRATION_STEP_IDS: readonly string[] = ['integration-gate', 'integration-review'];
/** Отказ публикации «голова не в последнем зелёном слиянии» (`step.ended.reason`). */
const REINTEGRATE_REFUSAL = `${END_REASON.publishRefused}: reintegrate:`;

/** Единица интеграции: на машине `published` и дальше — интеграция зелёная (шаги сданы). */
const GREEN: ReadonlySet<string> = new Set([
  'ready-to-publish',
  'published',
  'answering',
  'done',
  'conditional',
]);

export function isIntegrationUnit(unit: Pick<UnitRecord, 'role'> | undefined): boolean {
  return unit?.role === INTEGRATION_ROLE;
}

/** Единица интеграции, ждущая эту единицу (`after` её называет); нет — `undefined`. */
export function integrationOf(
  state: TaskFoldState,
  unitId: string,
): [string, UnitRecord] | undefined {
  return Object.entries(state.units).find(
    ([id, u]) => id !== unitId && isIntegrationUnit(u) && u.after.includes(unitId),
  );
}

export type IntegratedGate =
  { kind: 'green' } | { kind: 'wait'; reason: string } | { kind: 'red'; reason: string };

/**
 * Ворота `integrated` для публикации единицы: интеграции нет — `null` (единица публикуется как
 * раньше); интеграция закрыта — красная (причина её конца); иначе — ждать.
 */
export function integratedGate(state: TaskFoldState, unitId: string): IntegratedGate | null {
  const found = integrationOf(state, unitId);
  if (!found) return null;
  const [id, unit] = found;
  // Зелёное — только сданные ворота: единица, дошедшая до «готово» одними пропусками (сценарий
  // правили без шагов интеграции), общую проверку не проходила — пустое «зелёное» было бы пропуском.
  if (GREEN.has(unit.state)) {
    if (!gatePassed(state, id))
      return { kind: 'red', reason: `integration ${id} red: its integration gate never passed` };
    // Зелёное прошлого круга не покрывает сдвинутую голову (P135 «перед КАЖДОЙ публикацией»):
    // пока новый круг не сдан, публикация ждёт его.
    const pending = roundPending(state, id);
    return pending ? { kind: 'wait', reason: pending } : { kind: 'green' };
  }
  if (unit.state === 'closed') {
    const why = closeReasonOf(state, id);
    return { kind: 'red', reason: `integration ${id} red${why ? `: ${why}` : ''}` };
  }
  return { kind: 'wait', reason: `publish waits for integration ${id} (${unit.state})` };
}

/** Последняя попытка шага единицы по id шага сценария; нет — `undefined`. */
function latestOf(state: TaskFoldState, unitId: string, stepDefId: string): StepRecord | undefined {
  let found: StepRecord | undefined;
  for (const s of Object.values(state.steps))
    if (
      s.unitId === unitId &&
      s.stepDefId === stepDefId &&
      (!found || s.startedSeq > found.startedSeq)
    )
      found = s;
  return found;
}

/**
 * Отказ публикации единицы интеграции «голова не в последнем слиянии» (`reintegrate`, крючок
 * `integration-hooks.ts`), начатый позже последней попытки ворот: нужен новый круг. Самый поздний.
 */
function reintegrateAfter(
  state: TaskFoldState,
  unit: UnitRecord,
  sinceSeq: number,
): StepRecord | undefined {
  let found: StepRecord | undefined;
  for (const s of Object.values(state.steps)) {
    if (!unit.after.includes(s.unitId) || s.state !== 'failed' || s.startedSeq <= sinceSeq)
      continue;
    if (!(s.reason ?? '').startsWith(REINTEGRATE_REFUSAL)) continue;
    if (!found || s.startedSeq > found.startedSeq) found = s;
  }
  return found;
}

/**
 * Круг интеграции не досдан: последняя попытка ворот не `done`, после неё пришёл отказ
 * `reintegrate`, или ревью общего диффа ещё не прошло над этим кругом. `null` — круг сдан.
 */
function roundPending(state: TaskFoldState, id: string): string | null {
  const unit = state.units[id]!;
  const gate = latestOf(state, id, INTEGRATION_STEP_IDS[0]!);
  if (!gate || gate.state !== 'done')
    return `publish waits for integration ${id}: its gate round ${gate?.round ?? 0} is ${gate?.state ?? 'not started'}`;
  if (reintegrateAfter(state, unit, gate.startedSeq))
    return `publish waits for integration ${id}: a unit head moved after its last green, the gate runs again`;
  const review = latestOf(state, id, INTEGRATION_STEP_IDS[1]!);
  if (
    review &&
    (review.startedSeq < gate.startedSeq || (review.state !== 'done' && review.state !== 'skipped'))
  )
    return `publish waits for integration ${id}: the combined review of round ${gate.round} is ${review.startedSeq < gate.startedSeq ? 'not started' : review.state}`;
  return null;
}

/** Единица дальше не работает: её голова больше не меняется (машина `core/states.ts`). */
const SETTLED: ReadonlySet<string> = new Set(['done', 'closed', 'conditional']);

/**
 * Ход единицы интеграции после зелёного (Q-1): отказ `reintegrate` новее её последних ворот —
 * новый круг ворот (головы сливаются заново, ревью общего диффа устаревает от него само). Сама
 * интеграция не кончается, пока хоть одна её единица ещё может сдвинуть голову: `done` конечно
 * (01 §State machines, `UNIT_MACHINE.terminal`), и вернуть её к воротам было бы нельзя — поэтому
 * новый круг — новая попытка шага в той же незаконченной единице, а не переоткрытие `done`.
 */
export function integrationRoundOf(
  state: TaskFoldState,
  unitId: string,
): { kind: 'start-step'; unitId: string; stepDefId: string; round: number; why: 'stale' } | null {
  const unit = state.units[unitId];
  if (!isIntegrationUnit(unit) || !GREEN.has(unit!.state)) return null;
  const gate = latestOf(state, unitId, INTEGRATION_STEP_IDS[0]!);
  if (!gate || gate.state !== 'done' || !reintegrateAfter(state, unit!, gate.startedSeq))
    return null;
  return {
    kind: 'start-step',
    unitId,
    stepDefId: INTEGRATION_STEP_IDS[0]!,
    round: gate.round + 1,
    why: 'stale',
  };
}

/**
 * Интеграция дошла до «опубликовано» (своего MR нет — это её конец хвоста), а её единицы ещё
 * идут: ждать. Иначе её копия снялась бы, и сдвиг головы после зелёного проверять было бы не на чем.
 */
export function integrationHold(state: TaskFoldState, unitId: string): string | null {
  const unit = state.units[unitId];
  if (!isIntegrationUnit(unit)) return null;
  const live = unit!.after.filter((id) => !SETTLED.has(state.units[id]?.state ?? 'closed'));
  return live.length > 0
    ? `integration ${unitId} stays open while its units publish: ${live.join(', ')}`
    : null;
}

/** Ворота интеграции единицы сданы хоть раз (шаг `integration-gate` в состоянии `done`). */
function gatePassed(state: TaskFoldState, unitId: string): boolean {
  return Object.values(state.steps).some(
    (s) => s.unitId === unitId && s.stepDefId === INTEGRATION_STEP_IDS[0] && s.state === 'done',
  );
}

/**
 * Причина конца единицы интеграции: провал её шага. Конфликт слияния голов держит шаг ворот
 * красным (`integration-hooks.ts`) до решения в задаче или «остановить» на пределе кругов — файлы
 * называет сигнал `integration-conflict` в журнале.
 */
function closeReasonOf(state: TaskFoldState, unitId: string): string | null {
  const failed = Object.values(state.steps)
    .filter((s) => s.unitId === unitId && s.state === 'failed')
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
  return failed?.reason ?? 'the integration copy was not laid out (see integration-conflict)';
}

/**
 * Пропуск шага по роли единицы: единица интеграции идёт только своими шагами, прочие единицы
 * их пропускают. `null` — правило молчит (шаг идёт по остальным правилам).
 */
export function integrationSkipOf(
  state: TaskFoldState,
  stepDefId: string,
  unitId: string,
): string | null {
  const own = INTEGRATION_STEP_IDS.includes(stepDefId);
  if (isIntegrationUnit(state.units[unitId]))
    return own
      ? null
      : `integration unit: step ${stepDefId} is not an integration step (gate, then combined review; no MR)`;
  return own ? `step ${stepDefId} runs only in the integration unit` : null;
}
