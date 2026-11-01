import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type {
  BriefSection,
  ConductorHooks,
  HookVerdict,
  Outgoing,
  PublishOutcome,
  StepCtx,
  UnitCtx,
} from './run.types.ts';

/**
 * Опрос крючков зон (CD§9) в постоянном порядке сборки: вердикты складываются по «и» — первый
 * отказ решает, разделы брифа и факты собираются от всех. Нет крючков — «да»: зона, которой ещё
 * нет, в этой точке ничего не решает (её отсутствие названо в отчёте зоны B, а не скрыто здесь).
 */

const OK: HookVerdict = { ok: true };

function and(a: HookVerdict, b: HookVerdict): HookVerdict {
  return a.ok ? b : a;
}

export async function unitStart(
  hooks: readonly ConductorHooks[],
  u: UnitCtx,
): Promise<{ verdict: HookVerdict; sections: BriefSection[] }> {
  let verdict = OK;
  const sections: BriefSection[] = [];
  for (const h of hooks) {
    if (!h.onUnitStart) continue;
    const got = await h.onUnitStart(u);
    verdict = and(verdict, got.verdict);
    sections.push(...got.sections);
  }
  return { verdict, sections };
}

export async function preStep(
  hooks: readonly ConductorHooks[],
  s: StepCtx,
): Promise<{ verdict: HookVerdict; sections: BriefSection[] }> {
  let verdict = OK;
  const sections: BriefSection[] = [];
  for (const h of hooks) {
    if (!h.preStep) continue;
    const got = await h.preStep(s);
    verdict = and(verdict, got.verdict);
    sections.push(...got.sections);
  }
  return { verdict, sections };
}

export async function postStep(
  hooks: readonly ConductorHooks[],
  s: StepCtx,
  claim: StepDoneCall | null,
): Promise<{ verdict: HookVerdict; facts: Record<string, unknown> }> {
  let verdict = OK;
  const facts: Record<string, unknown> = {};
  for (const h of hooks) {
    if (!h.postStep) continue;
    const got = await h.postStep(s, claim);
    verdict = and(verdict, got.verdict);
    Object.assign(facts, got.facts);
  }
  return { verdict, facts };
}

export async function finalGate(
  hooks: readonly ConductorHooks[],
  u: UnitCtx,
): Promise<{ verdict: HookVerdict; compositionId: string | null }> {
  let verdict = OK;
  let compositionId: string | null = null;
  for (const h of hooks) {
    if (!h.onFinalGate) continue;
    const got = await h.onFinalGate(u, { verdict, compositionId });
    verdict = and(verdict, got.verdict);
    compositionId ??= got.compositionId;
  }
  return { verdict, compositionId };
}

/**
 * Шаг публикации: первый крючок, давший ответ, решает (публикатор один). Нет ни одного — шаг не
 * может сдаться «да»: публикации не было (`publisher-unwired`), а не молчаливый пропуск.
 */
export async function publish(
  hooks: readonly ConductorHooks[],
  s: StepCtx,
  compositionId: string | null,
): Promise<PublishOutcome | null> {
  for (const h of hooks) {
    if (!h.onPublish) continue;
    const got = await h.onPublish(s, compositionId);
    if (got) return got;
  }
  return null;
}

export async function turnEnd(
  hooks: readonly ConductorHooks[],
  s: StepCtx,
  turn: { seq: number; hadStepDone: boolean },
): Promise<Outgoing[]> {
  const out: Outgoing[] = [];
  for (const h of hooks) if (h.onTurnEnd) out.push(...(await h.onTurnEnd(s, turn)).send);
  return out;
}

export async function unitEnd(hooks: readonly ConductorHooks[], u: UnitCtx): Promise<void> {
  for (const h of hooks) if (h.onUnitEnd) await h.onUnitEnd(u);
}

export async function taskEnd(
  hooks: readonly ConductorHooks[],
  taskId: string,
  at: 'ended',
): Promise<void> {
  for (const h of hooks) if (h.onTaskEnd) await h.onTaskEnd(taskId, at);
}
