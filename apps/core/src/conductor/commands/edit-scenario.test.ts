import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { SOLO_UNIT, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import {
  envelope,
  forkOfFeature,
  homeTask,
  HUMAN_PROOF,
} from '../scenario/__fixtures__/scenario-harness.ts';
import {
  libraryFile,
  presetStep,
  scenarioForStep,
  writeLibraryScenario,
} from '../scenario/index.ts';

/**
 * P70: правка сценария посреди задачи — новая версия в библиотеке один раз, `scenario.edited` с
 * разницей; идущий шаг держит свою версию, новый шаг идёт по правке, «применить сейчас» — с
 * безопасной точки. Устаревшая основа — 409 `state-conflict`; отказ называет каждое условие.
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

async function task(): Promise<Awaited<ReturnType<typeof homeTask>>> {
  const got = await homeTask();
  open.push(got.task);
  return got;
}

function startStep(t: LiveTask, scenario: { id: string; version: number }, stepDefId: string) {
  const unitId = Object.keys(t.state.units)[0] ?? newId();
  if (!t.state.units[unitId])
    t.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: { unitId, repoKey: 'r1', branch: 'b', ownedPaths: [], ...SOLO_UNIT },
    });
  const stepId = newId();
  t.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: 'work', stepDefId, round: 0, scenario, budgetMs: 0 },
  });
  return stepId;
}

const withCheck = (s: Scenario): Scenario => ({
  ...s,
  steps: [...s.steps, presetStep('extra-check', 'check', 'Доп. проверка', ['work'])],
});

describe('edit-scenario (P70)', () => {
  it('writes the version once, journals scenario.edited with a diff; running step keeps its version, next step takes the edit', async () => {
    const { task: t, libraryDir, env } = await task();
    const running = startStep(t, { id: 'feature', version: 1 }, 'work');
    const edit = forkOfFeature('team-flow', 1, withCheck);
    const got = await processCommand(
      t,
      envelope(t, 'edit-scenario', { scenario: edit, baseVersion: 1, applyNow: false }),
      HUMAN_PROOF,
      env,
    );
    expect(got).toMatchObject({
      status: 'applied',
      outcome: { from: 'feature@1', to: 'team-flow@1', applies: 'next-step' },
    });
    expect(JSON.parse(readFileSync(libraryFile(libraryDir, edit), 'utf8'))).toEqual(edit);
    const line = readJournalLines(t.dir, t.taskId).lines.find((l) => l.kind === 'scenario.edited');
    expect(line?.data).toMatchObject({
      from: { id: 'feature', version: 1 },
      to: { id: 'team-flow', version: 1 },
      diff: { added: ['extra-check'], removed: [], changed: [], title: true },
      applyNow: false,
    });
    expect(t.state.scenario).toMatchObject({
      ref: { id: 'feature', version: 1 },
      pending: { to: { id: 'team-flow', version: 1 }, applyNow: false },
    });
    expect(t.state.steps[running]).toBeDefined();
    const fold = t.state.scenario as NonNullable<LiveTask['state']['scenario']>;
    // Идущий шаг — на своей версии и в безопасной точке, без «применить сейчас».
    expect(
      scenarioForStep({ fold, started: { id: 'feature', version: 1 }, atSafePoint: true }),
    ).toEqual({
      id: 'feature',
      version: 1,
    });
    // Новый шаг — по правке; его старт снимает ожидание (свёртка v6).
    expect(scenarioForStep({ fold, started: null, atSafePoint: false })).toEqual({
      id: 'team-flow',
      version: 1,
    });
    startStep(t, { id: 'team-flow', version: 1 }, 'review');
    expect(t.state.scenario).toMatchObject({ ref: { id: 'team-flow', version: 1 }, pending: null });
  });

  it('applyNow: the running step moves only at a safe point', async () => {
    const { task: t, env } = await task();
    startStep(t, { id: 'feature', version: 1 }, 'work');
    const got = await processCommand(
      t,
      envelope(t, 'edit-scenario', {
        scenario: forkOfFeature('now-flow', 1),
        baseVersion: 1,
        applyNow: true,
      }),
      HUMAN_PROOF,
      env,
    );
    expect(got).toMatchObject({ status: 'applied', outcome: { applies: 'next-safe-point' } });
    const fold = t.state.scenario as NonNullable<LiveTask['state']['scenario']>;
    const started = { id: 'feature', version: 1 };
    expect(scenarioForStep({ fold, started, atSafePoint: false })).toEqual(started);
    expect(scenarioForStep({ fold, started, atSafePoint: true })).toEqual({
      id: 'now-flow',
      version: 1,
    });
  });

  it('stale baseVersion → 409 state-conflict; every failed condition named at once; nothing written', async () => {
    const { task: t, libraryDir, env } = await task();
    const bad = { ...forkOfFeature('feature', 3), steps: [] } as unknown as Scenario;
    const got = await processCommand(
      t,
      envelope(t, 'edit-scenario', { scenario: bad, baseVersion: 2, applyNow: false }),
      HUMAN_PROOF,
      env,
    );
    expect(got.status).toBe('rejected');
    if (got.status !== 'rejected') return;
    expect(got.code).toBe('state-conflict');
    expect(got.reason).toContain("base version 2 is not the task's current feature@1");
    expect(got.reason).toContain('feature is a built-in preset id');
    expect(got.reason).toContain('feature next version is 1, the edit says 3');
    expect(existsSync(libraryFile(libraryDir, { id: 'feature', version: 3 }))).toBe(false);
    expect(t.state.scenario?.pending).toBeNull();
  });

  it('the next version must be latest + 1 in the library; a taken version with other text is refused', async () => {
    const { task: t, libraryDir, env } = await task();
    await writeLibraryScenario(libraryDir, forkOfFeature('team-flow', 1));
    const skip = await processCommand(
      t,
      envelope(t, 'edit-scenario', {
        scenario: forkOfFeature('team-flow', 3),
        baseVersion: 1,
        applyNow: false,
      }),
      HUMAN_PROOF,
      env,
    );
    expect(skip).toMatchObject({ status: 'rejected', code: 'version-mismatch' });
    const ok = await processCommand(
      t,
      envelope(t, 'edit-scenario', {
        scenario: forkOfFeature('team-flow', 2),
        baseVersion: 1,
        applyNow: false,
      }),
      HUMAN_PROOF,
      env,
    );
    expect(ok).toMatchObject({ status: 'applied', outcome: { to: 'team-flow@2' } });
    // Основа следующей правки — последняя записанная версия задачи.
    const stale = await processCommand(
      t,
      envelope(t, 'edit-scenario', {
        scenario: forkOfFeature('team-flow', 3),
        baseVersion: 1,
        applyNow: false,
      }),
      HUMAN_PROOF,
      env,
    );
    expect(stale).toMatchObject({ status: 'rejected', code: 'state-conflict' });
  });

  it('a structurally broken scenario is invalid-scenario with the problem named', async () => {
    const { task: t, env } = await task();
    const broken = forkOfFeature('broken', 1, (s) => ({
      ...s,
      steps: s.steps.map((x) => (x.id === 'review' ? { ...x, after: ['gone'] } : x)),
    }));
    const got = await processCommand(
      t,
      envelope(t, 'edit-scenario', { scenario: broken, baseVersion: 1, applyNow: false }),
      HUMAN_PROOF,
      env,
    );
    expect(got).toMatchObject({
      status: 'rejected',
      code: 'invalid-scenario',
      reason: 'review: after unknown step gone',
    });
  });

  it('the library is the home of the command env, not the one next to the task folder', async () => {
    const { task: t, libraryDir } = await task();
    // Дом среды — другой каталог, чем `<дом задачи>/scenarios`: правка ложится туда, куда указала
    // среда команды (API ядра), а библиотека рядом с задачей остаётся нетронутой.
    const other = layoutOf(tempDir('scn-env-'));
    const edit = forkOfFeature('team-flow', 1);
    const got = await processCommand(
      t,
      envelope(t, 'edit-scenario', { scenario: edit, baseVersion: 1, applyNow: false }),
      HUMAN_PROOF,
      commandEnv({ layout: other }),
    );
    expect(got).toMatchObject({ status: 'applied' });
    expect(existsSync(libraryFile(other.scenarios, edit))).toBe(true);
    expect(existsSync(libraryFile(libraryDir, edit))).toBe(false);
  });
});
