import { describe, expect, it } from 'vitest';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { readJournalLines } from '../../journal/read-lines.ts';
import { DEFERRABLE } from '../../economy/window/index.ts';
import { presetStep } from '../scenario/presets.ts';
import { BUDGET_ANSWERS, ROUND_CAP_ANSWERS } from '../next/next.types.ts';
import { attempts, openAsk, ROUTE, stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Вопросы дирижёра на языке задачи (этап 10, F1): задача, запущенная с английской панели
 * (`task.created.lang = 'en'`), получает точки 6 и 7 по-английски — текст и варианты; ответ
 * сверяется по ключу варианта среди подписей всех языков, поэтому русский ответ, записанный до
 * перевода, после перезапуска ядра ведёт к тому же действию. Задача без языка — по-русски, как было.
 */

const FEATURE = { id: 'feature', version: 1 };
const ONE_MIN = 60_000;

type Asked = JournalDataV1['human.asked'];

const asked = (s: Stand, askId: string): Asked =>
  readJournalLines(s.dir, s.taskId).lines.find(
    (l) => l.kind === 'human.asked' && (l.data as Asked).askId === askId,
  )!.data as Asked;

function single(extra: Partial<Scenario['steps'][number]>): Scenario {
  const step = presetStep('work', 'work', 'Работа', []);
  return { id: 'lang-work', version: 1, title: 't', steps: [{ ...step, ...extra }] };
}

const workStep = (s: Stand) =>
  Object.entries(s.task.state.steps).find(([, r]) => r.stepDefId === 'work');

const silentTwice = { 'work:0': 'silent', 'work:1': 'silent' } as const;
const workAttempts = (s: Stand) => attempts(s.task).filter((a) => a.startsWith('work:'));
const THIRD_RUNS = ['work:0:failed:derived', 'work:1:failed:derived', 'work:2:done:claimed'];

describe('conductor questions follow the task language', () => {
  it('en task: the round-cap raise is English and «One more round» runs one more attempt', async () => {
    const s = await stand(FEATURE, { model: { ...silentTwice }, lang: 'en' });
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:')!;
    expect(askId).toBeDefined();
    const a = asked(s, askId);
    // Заголовок шага пресета — тоже на языке задачи (F4), не русская строка данных.
    expect(a.question).toMatch(/^Step “Work” used up its rounds \(\d+\)\. What next\?$/);
    expect(a.options).toEqual(['One more round', 'Stop the unit', 'Cancel the task']);
    await s.answer(askId, 'One more round');
    await s.run.idle();
    expect(workAttempts(s)).toEqual(THIRD_RUNS);
    await s.stop();
  });

  it('en task answered with the Russian label written before the translation: after a core restart the same next round runs', async () => {
    const s = await stand(FEATURE, { model: { ...silentTwice }, lang: 'en' });
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:')!;
    await s.restart();
    await s.answer(askId, ROUND_CAP_ANSWERS.more);
    await s.run.idle();
    expect(workAttempts(s)).toEqual(THIRD_RUNS);
    await s.stop();
  });

  it('en task: «Stop the unit» stops instead of running another round', async () => {
    const s = await stand(FEATURE, { model: { ...silentTwice }, lang: 'en' });
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:')!;
    await s.answer(askId, 'Stop the unit');
    await s.run.idle();
    expect(workAttempts(s)).toEqual(['work:0:failed:derived', 'work:1:failed:derived']);
    await s.stop();
  });

  it('task without a language keeps the Russian question and options', async () => {
    const s = await stand(FEATURE, { model: { ...silentTwice } });
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:')!;
    const a = asked(s, askId);
    expect(a.question).toMatch(/^Шаг «Работа» исчерпал круги \(\d+\)\. Что дальше\?$/);
    expect(a.options).toEqual(Object.values(ROUND_CAP_ANSWERS));
    await s.stop();
  });

  it('en task: the time-budget raise is English and «Extend the limit» extends the step', async () => {
    const s = await stand(single({ budget: { minutes: 1 }, overBudget: 'ask' }), {
      model: { 'work:0': 'hold' },
      lang: 'en',
    });
    await s.until(() => s.port.sessions.size === 1);
    s.clock.advance(ONE_MIN + 1);
    s.run.wake();
    await s.until((t) => openAsk(t, 'budget:') !== undefined);
    const askId = openAsk(s.task, 'budget:')!;
    const a = asked(s, askId);
    expect(a.question).toBe('Step “Work” ran over its time limit (1 min). Extend it?');
    expect(a.options).toEqual(['Extend the limit', 'Stop the step']);
    await s.answer(askId, 'Extend the limit');
    await s.until(() => workStep(s)?.[1].extensions === 1);
    expect(workStep(s)?.[1]).toMatchObject({ state: 'running', budgetMs: 2 * ONE_MIN });
    await s.stop();
  });

  it('en task: the token-budget raise is English, the Russian legacy «extend» still doubles the limit', async () => {
    const s = await stand(single({ budget: { tokens: 100 }, overBudget: 'ask' }), {
      model: { 'work:0': 'hold' },
      journalSessions: true,
      lang: 'en',
    });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = workStep(s)!;
    s.port.usage(stepId, { input: 90, output: 20 });
    await s.until(() => openAsk(s.task, 'budget-tokens:') !== undefined);
    const askId = openAsk(s.task, `budget-tokens:${stepId}:100`)!;
    const a = asked(s, askId);
    expect(a.question).toBe('Step “Work” ran over its token budget (110 of 100). Extend it?');
    expect(a.options).toEqual(['Extend the limit', 'Stop the step']);
    await s.answer(askId, BUDGET_ANSWERS.more);
    await s.until(() => s.task.state.budgets[`tokens:step:${stepId}`]?.limit === 200);
    expect(s.task.state.steps[stepId]?.state).toBe('running');
    await s.stop();
  });

  it('en task: the exhausted-route raise is English and «Stop the step» stops it', async () => {
    const exhausted: WindowDecision = {
      routeId: ROUTE.route.id,
      limitKind: 'window',
      verdict: 'exhausted',
      defer: [...DEFERRABLE],
      resumeAt: null,
      reasons: ['exhausted'],
    };
    const s = await stand(single({}), {
      economy: { windows: () => [exhausted], recheckMs: 10 },
      lang: 'en',
    });
    await s.until(() => openAsk(s.task, 'exhausted:') !== undefined);
    const askId = openAsk(s.task, 'exhausted:')!;
    const a = asked(s, askId);
    expect(a.question).toMatch(/^Route claude-login has used up its paid budget/);
    expect(a.question).toContain('step “Work” has no other allowed route');
    expect(a.options).toEqual(['Wait for a top-up', 'Stop the step']);
    await s.answer(askId, 'Stop the step');
    await s.until((t) => t.state.ended !== null);
    expect(workStep(s)?.[1].reason).toMatch(/^budget: route claude-login exhausted, human stop/);
    expect(s.port.opened).toHaveLength(0);
    await s.stop();
  });
});
