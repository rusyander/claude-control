import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { SESSION_STATE_V, type SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { stepTokens, tokenLimit } from '../next/window.ts';

/**
 * Документ `agentdeck state` (03:81-82, G8) — для авторов хуков человека: шаг, требования с
 * вердиктами, свои пути, обязательные проверки, бюджеты, ожидание CI, режим слоя. Чистая функция
 * над свёрткой задачи: и ручка ядра (`source: 'core'`), и снимок запуска (`source: 'snapshot'`)
 * собирают документ ОДНИМ путём — расхождения формы между ними не бывает. Секретов в документе нет
 * по построению: только поля свёртки (журнал уже под маской DLP), ни токена, ни окружения.
 */

export interface StateDocInput {
  state: TaskFoldState;
  stepId: string;
  /** Определение шага из сценария задачи; `null` — сценарий не найден (документ не собирается). */
  def: StepDef | null;
  source: SessionStateDoc['source'];
  /** Выученный предел токенов (когда ни продления, ни сценарного предела нет). */
  learnedTokens?: number;
}

export type StateDocOutcome = { value: SessionStateDoc } | { unknown: string };

const MINUTE_MS = 60_000;

/** Минуты с одной десятой: автору хука нужна величина, а не миллисекунды. */
const minutesOf = (ms: number): number => Math.round((ms / MINUTE_MS) * 10) / 10;

export function sessionStateDoc(input: StateDocInput): StateDocOutcome {
  const { state, stepId, def } = input;
  const rec = Object.hasOwn(state.steps, stepId) ? state.steps[stepId] : undefined;
  if (!rec) return { unknown: `step ${stepId} not in the task journal` };
  if (!state.created) return { unknown: 'task.created missing' };
  // Шаг без определения — не «пустой шаг»: заголовок, проверки и режим слоя неизвестны (F25).
  if (!def) return { unknown: `step definition ${rec.stepDefId} not found in the task scenario` };
  if (def.id !== rec.stepDefId)
    return { unknown: `step definition ${def.id} is not ${rec.stepDefId} of step ${stepId}` };
  const unit = Object.hasOwn(state.units, rec.unitId) ? state.units[rec.unitId] : undefined;
  const requirements = Object.entries(state.requirements)
    .sort(([, a], [, b]) => a.ordinal - b.ordinal)
    .map(([id, r]) => ({ id, text: r.text, verdict: r.verdict }));
  return {
    value: {
      v: SESSION_STATE_V,
      source: input.source,
      asOf: state.seq,
      task: state.taskId,
      step: { id: stepId, kind: rec.stepKind, title: def.title, defId: rec.stepDefId },
      requirements,
      ownedPaths: [...(unit?.ownedPaths ?? [])],
      requiredChecks: [...def.checks.required],
      budgets: {
        tokens: {
          spent: stepTokens(state, stepId),
          limit: tokenLimit(state, def, stepId, input.learnedTokens),
        },
        minutes: {
          spent: minutesOf(Math.max(0, state.work.activeMs - rec.workAtStart)),
          // Срок шага 0 — без срока (`StepExtra.budgetMs`).
          limit: rec.budgetMs > 0 ? minutesOf(rec.budgetMs) : null,
        },
      },
      ciWait: state.created.ciWait,
      layer: { hooks: def.userLayer.hooks, skills: def.userLayer.skills },
    },
  };
}
