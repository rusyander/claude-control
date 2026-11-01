import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { deny, type Refusal } from './judge-helpers.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Навык и подагент человека в сессии ядра (06:115, 06:124, G5): судятся только по фактам слоя
 * сеанса. Нет фактов — отказ с именем, как прежде у `other`: класс, которого ядро не доказало,
 * не разрешается молча.
 */

/**
 * Итог ветки слоя: сигнала владения не несёт (его ставит только правка). Решение класса `permit`
 * отдаёт один `decidePermit` (P01) — ветка лишь свой итог, как `ReadVerdict` у чтения.
 */
export type LayerVerdict = Refusal | { allow: true; signal: null; reason: string };

/** Навык — только инструкции модели: разрешён, когда навыки сеанса включены, и на шаге чтения. */
export function skillVerdict(ask: PermissionAsk, ctx: PermitContext): LayerVerdict {
  if (ctx.layer?.skills === 'on')
    return { allow: true, signal: null, reason: `skill ${ask.target}: user skills are on` };
  const why = ctx.layer ? 'user skills are off for this session' : 'no user layer facts';
  return deny('skills-off', `skill ${ask.target}: ${why}`, null);
}

/** `inherit` в определении — то же, что нет модели: модель сеанса, не выше её. */
const named = (model: string | null | undefined): string | null =>
  model && model !== 'inherit' ? model : null;

/**
 * Подагент: пущен пробой (`caps.subagentHooks`), на шаге чтения — только если запреты держатся
 * внутри него; модель вызова или определения не выше потолка, ранг неизвестен — отказ.
 */
export function subagentVerdict(
  ask: PermissionAsk,
  ctx: PermitContext,
  stepKind?: string,
): LayerVerdict {
  const sub = ctx.subagents;
  if (!sub?.allowed) {
    const why = sub ? 'the probe has not proven core hooks hold inside subagents' : 'no facts';
    return deny('subagent-unproven', `subagent ${ask.target}: ${why}`, null);
  }
  if (stepKind !== undefined && (toolPlanFor(stepKind)?.builtins ?? 'read-only') === 'read-only') {
    if (!sub.readOnlyHolds)
      return deny(
        'read-only-step',
        `step kind ${stepKind} is read-only: subagent ${ask.target} could edit`,
        null,
      );
  }
  const explicit = named(ask.model);
  const fromDefinition = explicit === null ? named(sub.definitionModel?.(ask.target)) : null;
  const model = explicit ?? fromDefinition;
  if (model === null)
    return {
      allow: true,
      signal: null,
      reason: `subagent ${ask.target}: inherits the session model`,
    };
  const source = explicit !== null ? 'requested' : `definition ${ask.target}`;
  const rank = sub.modelRank(model);
  if (rank === null)
    return deny(
      'subagent-model-unknown',
      `subagent ${ask.target}: ${source} model ${model} has no known rank`,
      null,
    );
  if (sub.ceilingRank === null)
    return deny(
      'subagent-model-unknown',
      `subagent ${ask.target}: ${source} model ${model}, but the ceiling rank is unknown`,
      null,
    );
  if (rank > sub.ceilingRank)
    return deny(
      'model-above-ceiling',
      `subagent ${ask.target}: ${source} model ${model} is above the task ceiling`,
      null,
    );
  return {
    allow: true,
    signal: null,
    reason: `subagent ${ask.target}: ${source} model ${model} within the ceiling`,
  };
}
