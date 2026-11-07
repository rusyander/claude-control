import { describe, expect, it } from 'vitest';
import { STAGE11_I2 } from './__fixtures__/library/stage11-i2.ts';
import { clisOf, runStubTask } from './__fixtures__/observer-harness/index.ts';

/**
 * Расход сверх оценки на стенде ходов (этап 11, F3, P143): задача библиотеки идёт через настоящие
 * рантайм сессии, кран экономики (`usage` → `turn.usage`), наблюдатель со всеми предикатами,
 * судью каталога и `decideNext`. Оценка — строка `estimate-history` на создании. Сигнал — одна
 * строка `info`/`show`, шаг не снят, не запаркован и не ждёт человека; почти-двойники молчат.
 */

const task = (id: string) => {
  const t = STAGE11_I2.find((x) => x.id === id);
  if (!t) throw new Error(`no stub task ${id}`);
  return t;
};

describe('stage 11 spend over the estimate on the stub-task harness (F3, P143)', () => {
  it('a history estimate overspent past 2×: one info note shown, the step runs to step_done on every CLI', async () => {
    const stub = task('spend-over-estimate');
    for (const cli of clisOf(stub.dialects)) {
      const run = await runStubTask(stub, cli);
      expect(run.notes, cli).toEqual([]);
      const spend = run.signals.filter((s) => s.signal === 'spend-over-estimate');
      expect(spend, cli).toHaveLength(1);
      expect(spend[0], cli).toMatchObject({ severity: 'info', action: 'show' });
      expect(run.fired, cli).toEqual(['spend-over-estimate']);
      expect(run.stoppedAt, cli).toBeNull();
      expect(run.waitingAt, cli).toBeNull();
      // step_done принят: дирижёр ведёт задачу дальше, а не снимает и не паркует шаг.
      expect(run.next, cli).toBe('post-step');
      expect(run.kinds.filter((k) => k === 'turn.usage').length, cli).toBeGreaterThanOrEqual(2);
      expect(run.kinds, cli).toContain('step.transition');
    }
  }, 120_000);

  it('near-miss: the same spend under a no-history estimate, and the history estimate below 2×, stay silent', async () => {
    for (const id of ['spend-over-estimate-no-history', 'spend-under-estimate']) {
      const stub = task(id);
      for (const cli of clisOf(stub.dialects)) {
        const run = await runStubTask(stub, cli);
        expect(run.notes, `${id}/${cli}`).toEqual([]);
        expect(run.fired, `${id}/${cli}`).toEqual([]);
        expect(run.stoppedAt, `${id}/${cli}`).toBeNull();
      }
    }
  }, 120_000);
});
