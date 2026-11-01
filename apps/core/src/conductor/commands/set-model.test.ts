import { afterEach, describe, expect, it } from 'vitest';
import { SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import {
  API_KEY,
  envelope,
  homeTask,
  HUMAN_PROOF,
  LOGIN,
  QWEN,
} from '../scenario/__fixtures__/scenario-harness.ts';
import { decideRouting, presetStep, routeStep } from '../scenario/index.ts';

/**
 * G9 + P80 (строки tier/continuation): `set-model` / `set-cli` принимают правку только если
 * судья `tier` с ней выбрал бы маршрут из набора задачи — и шаг, стартующий после правки,
 * получает ровно этот выбор: одно решение с обоих входов (команда и старт шага).
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

async function task() {
  const got = await homeTask({ allowedRoutes: [API_KEY, LOGIN, QWEN], modelCeiling: null });
  open.push(got.task);
  const unitId = newId();
  got.task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch: 'b', ownedPaths: [], ...SOLO_UNIT },
  });
  const stepId = newId();
  got.task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: {
      stepId,
      unitId,
      stepKind: 'work',
      stepDefId: 'work',
      round: 0,
      scenario: { id: 'feature', version: 1 },
      budgetMs: 0,
    },
  });
  return { ...got, unitId, stepId };
}

const WORK = presetStep('work', 'work', 'Работа', []);

describe('set-model / set-cli (G9, P80)', () => {
  it('set-model on a step: two override lines; the step routing then picks exactly that model', async () => {
    const { task: t, unitId, stepId } = await task();
    const got = await processCommand(
      t,
      envelope(t, 'set-model', {
        scope: 'step',
        scopeId: stepId,
        model: 'claude-opus-5',
        effort: 'high',
        timing: 'safe-point',
      }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({
      status: 'applied',
      outcome: { adapter: 'claude', route: 'cli-login:cli-login-claude', model: 'claude-opus-5' },
    });
    expect(t.state.overrides.map((o) => [o.scope, o.field, o.value])).toEqual([
      ['step', 'model', 'claude-opus-5'],
      ['step', 'effort', 'high'],
    ]);
    const routing = decideRouting(t.state, { stepId, unitId, def: WORK });
    expect(routing.tier).toMatchObject({
      ok: true,
      adapter: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      sources: { model: 'override-step', effort: 'override-step' },
    });
  });

  it('set-cli on the unit moves its steps to that adapter; routeStep journals tier + continuation decisions', async () => {
    const { task: t, unitId, stepId } = await task();
    const got = await processCommand(
      t,
      envelope(t, 'set-cli', { scope: 'unit', scopeId: unitId, adapter: 'qwen', timing: 'now' }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({
      status: 'applied',
      outcome: { adapter: 'qwen', model: 'qwen3-coder' },
    });
    const routing = routeStep(t, { stepId, unitId, def: WORK });
    expect(routing.tier).toMatchObject({ ok: true, adapter: 'qwen', route: QWEN.route });
    expect(routing.continuation).toMatchObject({ mode: 'fresh', reason: 'no-live-session' });
    const decisions = readJournalLines(t.dir, t.taskId)
      .lines.filter((l) => l.kind === 'decision')
      .map((l) => (l.data as { class: string }).class);
    expect(decisions).toEqual(['tier', 'continuation']);
  });

  it('outside the allowed set → refused with every reason, no override line', async () => {
    const { task: t } = await task();
    const got = await processCommand(
      t,
      envelope(t, 'set-model', {
        scope: 'task',
        scopeId: t.taskId,
        model: 'gpt-6',
        effort: null,
        timing: 'safe-point',
      }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({
      status: 'rejected',
      code: 'outside-allowed-set',
      reason: 'model gpt-6 (override-task) matches no allowed route pattern',
    });
    const cli = await processCommand(
      t,
      envelope(t, 'set-cli', { scope: 'task', scopeId: t.taskId, adapter: 'codex', timing: 'now' }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(cli).toMatchObject({ status: 'rejected', code: 'outside-allowed-set' });
    expect(t.state.overrides).toEqual([]);
  });

  it('unknown scope id is named per scope', async () => {
    const { task: t } = await task();
    const other = newId();
    for (const scope of ['task', 'unit', 'step'] as const) {
      const got = await processCommand(
        t,
        envelope(t, 'set-cli', { scope, scopeId: other, adapter: 'claude', timing: 'now' }),
        HUMAN_PROOF,
        commandEnv(),
      );
      expect(got).toMatchObject({ status: 'rejected', code: 'unknown-scope' });
      if (got.status === 'rejected') expect(got.reason?.startsWith(`scope ${scope}:`)).toBe(true);
    }
  });

  it('P80: for every override row the command verdict and the step routing verdict agree', async () => {
    const cases = [
      { model: 'claude-sonnet-5', ok: true },
      { model: 'qwen3-coder', ok: true },
      { model: 'qwen3-max', ok: false },
      { model: 'gpt-6', ok: false },
    ];
    for (const c of cases) {
      const { task: t, unitId, stepId } = await task();
      const cmd = await processCommand(
        t,
        envelope(t, 'set-model', {
          scope: 'step',
          scopeId: stepId,
          model: c.model,
          effort: null,
          timing: 'now',
        }),
        HUMAN_PROOF,
        commandEnv(),
      );
      expect({ model: c.model, status: cmd.status }).toEqual({
        model: c.model,
        status: c.ok ? 'applied' : 'rejected',
      });
      // Отказанная команда ничего не пишет — шаг идёт без правки; принятая — шаг видит её.
      const routing = decideRouting(t.state, { stepId, unitId, def: WORK });
      expect(routing.tier.ok).toBe(true);
      if (c.ok && routing.tier.ok) expect(routing.tier.model).toBe(c.model);
    }
  });
});
