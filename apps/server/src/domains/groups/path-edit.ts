import type { Group } from '@agentdeck/contracts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { pathStepsEditSchema, pathStepTooLong } from '@agentdeck/contracts/group-path';
import { coded } from '../../lib/server-text/server-text.ts';

/**
 * Правка своих шагов «Пути» одним запросом: клиент присылает весь список —
 * вставка, перенос, правка и удаление сводятся к одному «вот каким он стал».
 * Частичные операции (вставить после X) расходились бы с тем, что человек
 * видел, как только две вкладки правили путь одновременно.
 */

export class InvalidPathStepsError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_path_steps';

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidPathStepsError';
    coded(this, 'group-path-steps-invalid', { detail });
  }
}

/**
 * Проверить и привести список: форма по схеме, id уникальны, длина в пределах,
 * `order` внутри стадии — подряд с нуля в присланном порядке. Последнее не
 * косметика: конвейер идёт по `order`, а у списка после переноса двух шагов
 * одинаковый номер означал бы порядок «как повезёт с сортировкой».
 */
export function normalizePathSteps(body: unknown): PathStep[] {
  const parsed = pathStepsEditSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvalidPathStepsError(`${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`);
  }

  const seen = new Set<string>();
  for (const step of parsed.data.steps) {
    if (seen.has(step.id)) throw new InvalidPathStepsError(`duplicate step id ${step.id}`);
    seen.add(step.id);
    if (pathStepTooLong(step)) throw new InvalidPathStepsError(`step ${step.id} is too long`);
    if (step.kind === 'resource' && !step.resource) {
      throw new InvalidPathStepsError(`step ${step.id}: a resource step names its resource`);
    }
    // Шаги скиллов идут в стадии работы (`SKILL_STEPS_AFTER`): шаг внутри скилла
    // с другой стадией рисовался бы в одном месте, а шёл бы в другом.
    if (step.within && step.anchor !== 'work') {
      throw new InvalidPathStepsError(`step ${step.id}: a step inside a skill belongs to work`);
    }
  }

  const sorted = parsed.data.steps
    .map((step, position) => ({ step, position }))
    .sort((a, b) => a.step.order - b.step.order || a.position - b.position);
  const counters = new Map<string, number>();
  const orderOf = new Map<string, number>();
  for (const { step } of sorted) {
    const next = counters.get(step.anchor) ?? 0;
    orderOf.set(step.id, next);
    counters.set(step.anchor, next + 1);
  }
  return parsed.data.steps.map((step) => ({ ...step, order: orderOf.get(step.id) ?? 0 }));
}

/** Группа с новым списком шагов; остальные поля записи не трогаются. */
export function withPathSteps(group: Group, steps: PathStep[]): Group {
  return { ...group, path: { steps } };
}
