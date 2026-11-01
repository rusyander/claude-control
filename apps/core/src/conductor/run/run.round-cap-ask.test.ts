import { describe, expect, it } from 'vitest';
import { readJournalLines } from '../../journal/read-lines.ts';
import { ASK_REMINDER } from '../human/ledger.ts';
import { ROUND_CAP_ANSWERS } from '../next/next.types.ts';
import { attempts, openAsk, stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Точка 6 на уже кончившемся шаге (02:51, G14): вопрос «что дальше» задаётся после `step.ended`
 * попытки — ревью следующего круга или повтор шага без исхода. Уход за вопросами (E) идёт по
 * таймеру исполнителя, как в ядре: вопрос обязан остаться открытым и дождаться человека, а не
 * сняться следующей же строкой журнала (дефект s9: задача ждала вопроса, которого никто не видит).
 */

const FEATURE = { id: 'feature', version: 1 };
const MIN = 60_000;

const lines = (s: Stand) => readJournalLines(s.dir, s.taskId).lines;
const withdrawals = (s: Stand, askId: string) =>
  lines(s).filter(
    (l) =>
      l.kind === 'ask.transition' &&
      (l.data as { askId: string; event: string }).askId === askId &&
      (l.data as { event: string }).event === 'withdraw',
  );
const reminders = (s: Stand, askId: string) =>
  lines(s).filter(
    (l) =>
      l.kind === 'signal' &&
      (l.data as { signal: string; subject: string }).signal === ASK_REMINDER &&
      (l.data as { subject: string }).subject === askId,
  );

/**
 * Один проход ухода, который точно видел вопрос: через 15 минут он либо напомнит, либо снимет —
 * ждём любого из двух, иначе зелёный под нагрузкой значил бы «таймер ещё не сработал».
 */
async function upkeepPass(s: Stand, askId: string): Promise<void> {
  s.clock.advance(15 * MIN + 1);
  await s.until(() => reminders(s, askId).length + withdrawals(s, askId).length > 0);
}

describe('point 6 raised on an ended step survives ask upkeep', () => {
  it('review rounds: the round-cap ask after a done review stays open, reminds, and its answer runs the next round', async () => {
    const model: Record<string, 'claim-blocking'> = {};
    for (const r of [0, 1, 2, 3]) model[`review:${r}`] = 'claim-blocking';
    const s = await stand(FEATURE, { model, upkeepEveryMs: 5 });
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:');
    expect(askId).toBeDefined();
    const ask = s.task.state.asks[askId!]!;
    // Вопрос привязан к кончившейся попытке ревью — это и есть случай дефекта.
    expect(s.task.state.steps[ask.stepId!]?.state).toBe('done');
    await upkeepPass(s, askId!);
    expect(withdrawals(s, askId!)).toEqual([]);
    expect(reminders(s, askId!)).toHaveLength(1);
    expect(s.task.state.asks[askId!]?.state).toBe('open');
    await s.answer(askId!, ROUND_CAP_ANSWERS.more);
    await s.run.idle();
    expect(attempts(s.task).slice(9, 11)).toEqual(['review:3:done:claimed', 'fix:3:done:claimed']);
    expect(s.task.state.asks[askId!]?.state).toBe('answered');
    await s.stop();
  });

  it('no outcome twice: the point 6 ask after the failed retry stays open and its answer starts one more attempt', async () => {
    const s = await stand(FEATURE, {
      model: { 'work:0': 'silent', 'work:1': 'silent' },
      upkeepEveryMs: 5,
    });
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:');
    expect(askId).toBeDefined();
    expect(s.task.state.steps[s.task.state.asks[askId!]!.stepId!]?.state).toBe('failed');
    await upkeepPass(s, askId!);
    expect(withdrawals(s, askId!)).toEqual([]);
    expect(s.task.state.asks[askId!]?.state).toBe('open');
    await s.answer(askId!, ROUND_CAP_ANSWERS.more);
    await s.run.idle();
    expect(attempts(s.task).filter((a) => a.startsWith('work:'))).toEqual([
      'work:0:failed:derived',
      'work:1:failed:derived',
      'work:2:done:claimed',
    ]);
    await s.stop();
  });
});
