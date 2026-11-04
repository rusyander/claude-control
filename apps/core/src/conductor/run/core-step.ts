import { publicationOf } from '../../journal/reduce/publish.ts';
import { END_REASON } from '../next/next.types.ts';
import { stepAskIn, titleLangOf } from '../scenario/titles.ts';
import * as hook from './hooks.ts';
import { failStep, settle, stepCtx, stepMove, type PerformCtx } from './moves.ts';
import type { StepCtx } from './run.types.ts';

/**
 * Шаг ядра без сессии модели: `ask-human` (точка 8), `check` и `final-gate` (крючки зон, состав —
 * у F, композиция коммитов — у P), `publish` (крючок публикатора, 05 §Push and MR).
 */

export async function runCoreStep(ctx: PerformCtx, stepId: string): Promise<void> {
  stepMove(ctx.task, stepId, 'start');
  const s = stepCtx(ctx, stepId);
  if (!s) return;
  if (s.def.kind === 'ask-human') {
    // Вопрос пресета — на языке задачи (этап 10, F8); вопрос человека — как записан.
    const ask = stepAskIn(s.def, titleLangOf(ctx.task.state.created?.lang))!;
    ctx.deps.raise({
      source: 'scenario-step',
      stepId,
      sessionId: null,
      action: null,
      point: 8,
      dedupe: `scenario-step:${stepId}`,
      question: ask.question,
      options: ask.options,
      recommendation: ask.recommendation,
      blocking: true,
    });
    return;
  }
  stepMove(ctx.task, stepId, 'check');
  if (s.def.kind === 'publish') return publishStep(ctx, s);
  // check / final-gate: факты и ворота — крючки зон; состав финальной проверки — у F.
  let verdict = (await hook.postStep(ctx.deps.hooks, s, null)).verdict;
  if (s.def.kind === 'final-gate' && verdict.ok) {
    verdict = (await hook.finalGate(ctx.deps.hooks, s)).verdict;
  }
  await settle(ctx, stepId, verdict, 'core');
}

/**
 * Публикация: решает крючок публикатора; ядро только пишет исход. Отказ — один, со всеми
 * несоблюдёнными условиями и тем, что дальше (P03): по нему `next` ведёт к правке, конфликту,
 * вопросу или ожиданию форжа. Нет публикатора — провал с причиной, никогда не «сдано».
 */
async function publishStep(ctx: PerformCtx, s: StepCtx): Promise<void> {
  const composed = publicationOf(ctx.task.state, s.unitId).composed;
  const got = await hook.publish(ctx.deps.hooks, s, composed?.compositionId ?? null);
  if (!got) {
    await failStep(ctx, s.stepId, `${END_REASON.publisherUnwired}: no publish hook answered`);
    return;
  }
  if (got.kind === 'refused') {
    const unmet = got.unmet.length > 0 ? got.unmet.join('; ') : 'unspecified';
    await failStep(ctx, s.stepId, `${END_REASON.publishRefused}: ${got.next}: ${unmet}`);
    return;
  }
  await settle(ctx, s.stepId, { ok: true }, 'core');
}
