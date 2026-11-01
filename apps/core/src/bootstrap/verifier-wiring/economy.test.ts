import { afterEach, describe, expect, it } from 'vitest';
import type { LimitFact } from '@agentdeck/contracts/core/economy';
import type { CheckRequest } from '@agentdeck/contracts/core/records';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { checkEconomy } from './economy.ts';

/**
 * Экономика во входе проверки на настоящих частях: реестр задач с журналом, сессия шага
 * (маршрут `stub-1`), книга окон ядра. Окно судит маршрут сессии шага, просящего проверку;
 * шаг без сессии и задача без отметки `fresh-rerun` не получают ни окна, ни разового прогона.
 */

const NOW = 1_000_000;
const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

const held: LimitFact = {
  routeId: 'stub-1',
  limitKind: 'window',
  usedPct: null,
  resetAt: NOW + 60_000,
  refusal: true,
  source: 'refusal',
  at: NOW - 1_000,
};

const req = (taskId: string, stepId: string | null) =>
  ({ taskId, stepId, unit: 'app', class: 'unit', phase: 'mid-task' }) as unknown as CheckRequest;

/** Обе части у `checkEconomy` есть всегда; тип `CheckDeps` держит их необязательными. */
function required(e: ReturnType<typeof checkEconomy>) {
  const { window, fresh } = e;
  if (!window || !fresh) throw new Error('checkEconomy lost a part');
  return { window, fresh };
}

describe('checkEconomy (verifier input: window by step route, fresh one-shot mark)', () => {
  it('the step session route is judged by the shared window book; another step and no book stay open', async () => {
    const registry = createTaskRegistry(tempDir('check-economy-'), deps());
    const task = await registry.create(CREATED);
    open.push(task);
    const { stepId } = seedSession(task, { stepKind: 'work' });
    const windows = new WindowBook();
    windows.observe(held);
    const econ = required(checkEconomy({ registry, windows, now: () => NOW }));

    const decided = econ.window(req(task.taskId, stepId));
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      routeId: 'stub-1',
      limitKind: 'window',
      verdict: 'refused',
    });
    expect(econ.window(req(task.taskId, 'other-step'))).toEqual([]);
    expect(econ.window(req(task.taskId, null))).toEqual([]);
    expect(
      required(checkEconomy({ registry, now: () => NOW })).window(req(task.taskId, stepId)),
    ).toEqual([]);
    expect(econ.fresh(req(task.taskId, stepId))).toBeNull();
    expect(econ.fresh(req('no-such-task', stepId))).toBeNull();
  });
});
