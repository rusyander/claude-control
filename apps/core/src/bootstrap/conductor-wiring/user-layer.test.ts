import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { MINI_SCENARIO, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { createUserLayerTap } from '../user-layer-wiring/tap.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { userLayerHooks } from './user-layer.ts';

/**
 * G-e, 06:122 «шаг подстраивается»: отказы хуков человека в прошлых шагах единицы — раздел
 * брифа `handoff` следующего шага с хуком, действием и числом; петля названа; отказы своего
 * шага и другой единицы туда не входят; нет отказов — нет раздела. Отказы пишет настоящий кран.
 */

const WORK = MINI_SCENARIO.steps[0] as StepDef;
const HOOK = 'PreToolUse:Bash:guard.sh';

const wiring = (task: LiveTask): ConductorWiringDeps =>
  ({
    registry: { live: (id: string) => (id === task.taskId ? task : undefined) },
    note: () => undefined,
  }) as unknown as ConductorWiringDeps;

const ctx = (
  task: LiveTask,
  s: { unitId: string; stepId: string; sessionId: string },
): StepCtx => ({
  taskId: task.taskId,
  unitId: s.unitId,
  repoKey: 'r1',
  copyDir: null,
  stepId: s.stepId,
  def: WORK,
  round: 0,
  sessionId: s.sessionId,
});

function refuse(task: LiveTask, sessionId: string, n: number, hook: string | null = HOOK): void {
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const tap = createUserLayerTap();
  for (let i = 0; i < n; i += 1) {
    const id = `${sessionId}-${i}`;
    const events: AdapterEvent[] = [
      {
        type: 'tool.requested',
        toolUseId: id,
        name: 'Bash',
        input: { command: 'git push' },
        cliInitiated: false,
      },
      {
        type: 'hook.refused',
        toolUseId: id,
        event: 'PreToolUse',
        hook,
        reason: 'no push',
        cliInitiated: false,
      },
    ];
    for (const e of events) tap.onEvent(task, got.binding, e);
  }
}

describe('G-e next-step brief names blocking user hooks (conductor-wiring/user-layer)', () => {
  it('no refusal in earlier steps gives no section', async () => {
    const { task } = await openFresh();
    const s1 = seedSession(task, { stepKind: 'work' });
    expect((await userLayerHooks(wiring(task)).preStep!(ctx(task, s1))).sections).toEqual([]);
    task.close();
  });

  it('the next step of the same unit gets a handoff section naming hook, action, count and the loop', async () => {
    const { task } = await openFresh();
    const s1 = seedSession(task, { stepKind: 'work' });
    refuse(task, s1.sessionId, 3);
    // Свой шаг себе бриф не пишет: отказы текущего шага в его бриф не входят.
    expect((await userLayerHooks(wiring(task)).preStep!(ctx(task, s1))).sections).toEqual([]);
    const s2 = seedSession(task, { stepKind: 'work', unitId: s1.unitId });
    const got = await userLayerHooks(wiring(task)).preStep!(ctx(task, s2));
    expect(got.verdict).toEqual({ ok: true });
    expect(got.sections).toEqual([
      {
        id: 'handoff',
        from: 'observer/hook-block',
        text: expect.stringContaining(
          `- ${HOOK}: Bash on PreToolUse: no push (3x) — stopped the step as a loop`,
        ),
      },
    ]);
    task.close();
  });

  it('refusals in another unit stay out; an unidentified hook is named as such', async () => {
    const { task } = await openFresh();
    const other = seedSession(task, { stepKind: 'work' });
    refuse(task, other.sessionId, 1);
    const s1 = seedSession(task, { stepKind: 'work' });
    refuse(task, s1.sessionId, 1, null);
    const s2 = seedSession(task, { stepKind: 'work', unitId: s1.unitId });
    const [section] = (await userLayerHooks(wiring(task)).preStep!(ctx(task, s2))).sections;
    expect(section?.text).toContain('- unidentified user hook: Bash on PreToolUse: no push');
    expect(section?.text).not.toContain(HOOK);
    task.close();
  });
});
