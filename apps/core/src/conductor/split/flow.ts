import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { LiveTask } from '../../journal/resume.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
import type { SplitDeliverable } from '../split-check/index.ts';
import { linesOf, reviewTargetsOf } from './journal-view.ts';
import { afterAccept, proposedOfClaim, proposeSplit, repoKeyFor } from './split.ts';
import type { AfterAccept, ProposalSource, ProposedUnit, SplitOutcome } from './split.types.ts';

/**
 * Где оценка кончается и предлагается деление (G6): после шага плана или деления; в сценарии без
 * них (только ревью) — после разбора. Шаг вне оценки (задача уже не `estimating`) не делит.
 */
export function isSplitPoint(steps: readonly StepDef[], def: StepDef): boolean {
  if (def.kind === 'plan' || def.kind === 'split') return true;
  return def.kind === 'intake' && !steps.some((s) => s.kind === 'plan' || s.kind === 'split');
}

/** Что сдаёт задача: сценарий «только ревью» — ревью, число MR — у разбора (02:19, 02:69). */
export function deliverableOf(scenarioId: string, mrCount: number | null): SplitDeliverable {
  return scenarioId === 'review-only' ? { kind: 'review', mrCount } : { kind: 'change' };
}

/** Соло: одна единица — единица 0 как есть (её имя, репозиторий, свои пути). */
function soloOf(task: LiveTask): ProposedUnit[] {
  const zero = Object.values(task.state.units).find((u) => u.splitId === null);
  return [
    {
      name: zero?.name ?? 'estimate',
      repoKey: zero?.repoKey ?? task.state.created?.repos[0]?.repoKey ?? '(not named)',
      ownedPaths: zero?.ownedPaths ?? ['**'],
      deps: [],
      contract: false,
      estimate: { minutes: null, tokens: null },
    },
  ];
}

export interface SplitPointResult {
  outcome: SplitOutcome;
  after: AfterAccept | null;
}

/**
 * Деление в точке конца оценки. Единицы — из заявления плана; разбор ревью с ≥ 2 целями —
 * единица на цель (предлагает ядро, по числу разбора); иначе соло. Проверка и решение — всегда
 * строками журнала; принято — политика запуска.
 */
export async function runSplitPoint(
  task: LiveTask,
  step: { stepId: string; def: StepDef },
  claim: StepDoneCall | null,
  scenario: { id: string; steps: readonly StepDef[] },
  env: SplitEnv,
  knownFiles?: Readonly<Record<string, readonly string[]>>,
): Promise<SplitPointResult | null> {
  if (task.state.task !== 'estimating' || !isSplitPoint(scenario.steps, step.def)) return null;
  const repos = task.state.created?.repos ?? [];
  // Заявление этого шага — первым: крючок конца шага может прийти раньше строки `step.claimed`.
  const targets = claim?.reviewTargets ?? reviewTargetsOf(linesOf(task));
  const deliverable = deliverableOf(scenario.id, targets ? targets.length : null);
  let units: ProposedUnit[];
  // Автор предложения: заявленные единицы и соло — план (в широком смысле, шаг конца оценки);
  // единица на цель ревью — ядро по счёту разбора.
  let by: ProposalSource['by'] = 'plan';
  if (claim?.units && claim.units.length > 0) units = proposedOfClaim(claim.units, repos);
  else if (step.def.kind === 'intake' && targets && targets.length >= 2) {
    by = 'core';
    units = targets.map((t, i) => ({
      name: `review-${i + 1}`,
      repoKey: repoKeyFor(t.repo, repos),
      // Ревью не правит файлы: своих путей нет, пересечься нечему.
      ownedPaths: [],
      deps: [],
      contract: false,
      estimate: { minutes: null, tokens: null },
    }));
  } else units = soloOf(task);
  const outcome = proposeSplit(
    task,
    units,
    { by, stepId: step.stepId },
    { deliverable, ...(knownFiles ? { knownFiles } : {}) },
    env,
  );
  if (outcome.decision.verdict !== 'accepted') return { outcome, after: null };
  return { outcome, after: await afterAccept(task, outcome, env) };
}
