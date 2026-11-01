import {
  scenarioProblems,
  type Scenario,
  type ScenarioRef,
  type StepDef,
} from '@agentdeck/contracts/core/scenario';
import { isPresetId } from './presets.ts';

/**
 * Правка сценария на ходу (02:35, G11, P70): новая версия целиком, записанная один раз. Чистые
 * части — суд над правкой, её разница и «какая версия у шага»; запись и журнал — у команды
 * `edit-scenario` (`conductor/commands/edit-scenario.ts`).
 */

export interface EditFields {
  scenario: Scenario;
  baseVersion: number;
  applyNow: boolean;
}

export type EditRefusalCode =
  'state-conflict' | 'preset-id-reserved' | 'invalid-scenario' | 'version-mismatch';

export type EditPlan =
  { ok: true; to: ScenarioRef } | { ok: false; code: EditRefusalCode; reasons: string[] };

/**
 * Годна ли правка. Отказ называет каждое невыполненное условие разом (P01), код — первого по
 * старшинству: устаревшая основа (409, как `expectSeq`) важнее формы новой версии.
 */
export function planScenarioEdit(
  current: ScenarioRef,
  latestInLibrary: number,
  fields: EditFields,
): EditPlan {
  const failed: { code: EditRefusalCode; reason: string }[] = [];
  const { scenario, baseVersion } = fields;
  // Правка другой основы — как устаревший `expectSeq`: человек правил не то, что идёт.
  if (baseVersion !== current.version)
    failed.push({
      code: 'state-conflict',
      reason: `base version ${baseVersion} is not the task's current ${current.id}@${current.version}`,
    });
  if (isPresetId(scenario.id))
    failed.push({
      code: 'preset-id-reserved',
      reason: `${scenario.id} is a built-in preset id; save the edit under a new id`,
    });
  for (const problem of scenarioProblems(scenario))
    failed.push({ code: 'invalid-scenario', reason: problem });
  const expected = latestInLibrary + 1;
  if (scenario.version !== expected)
    failed.push({
      code: 'version-mismatch',
      reason: `${scenario.id} next version is ${expected}, the edit says ${scenario.version}`,
    });
  const first = failed[0];
  if (first) return { ok: false, code: first.code, reasons: failed.map((f) => f.reason) };
  return { ok: true, to: { id: scenario.id, version: scenario.version } };
}

export interface ScenarioDiff {
  added: string[];
  removed: string[];
  /** Шаг тот же, поменялись его поля (имена верхнего уровня StepDef). */
  changed: { id: string; fields: string[] }[];
  title: boolean;
  /** Основа не прочлась — разница неизвестна, правка всё равно записана. */
  baseUnread?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function diffScenarios(from: Scenario, to: Scenario): ScenarioDiff {
  const before = new Map(from.steps.map((s) => [s.id, s]));
  const after = new Map(to.steps.map((s) => [s.id, s]));
  const changed: ScenarioDiff['changed'] = [];
  for (const [id, step] of after) {
    const old = before.get(id);
    if (!old) continue;
    const keys = new Set([...Object.keys(old), ...Object.keys(step)]) as Set<keyof StepDef>;
    const fields = [...keys].filter((k) => !same(old[k], step[k])).sort();
    if (fields.length > 0) changed.push({ id, fields });
  }
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed,
    title: from.title !== to.title,
  };
}

/** Сценарий задачи в свёртке v6: действующий и правка, ждущая следующего шага. */
export interface TaskScenarioFold {
  ref: ScenarioRef;
  pending: { to: ScenarioRef; applyNow: boolean } | null;
}

/** Основа следующей правки — последняя записанная версия, даже если шаг на ней ещё не начат. */
export function latestTaskScenario(fold: TaskScenarioFold): ScenarioRef {
  return fold.pending?.to ?? fold.ref;
}

/**
 * Какая версия сценария у шага (P70). Новый шаг — правка, если есть, иначе действующая. Идущий
 * шаг держит свою (`step.started.scenario`) и меняется только по «применить сейчас» и только в
 * безопасной точке — иначе модель посреди хода получила бы другие правила.
 */
export function scenarioForStep(input: {
  fold: TaskScenarioFold;
  /** `step.started.scenario` идущего шага; `null` — шаг ещё не начат. */
  started: ScenarioRef | null;
  atSafePoint: boolean;
}): ScenarioRef {
  const { fold, started, atSafePoint } = input;
  if (!started) return latestTaskScenario(fold);
  if (fold.pending?.applyNow && atSafePoint) return fold.pending.to;
  return started;
}
