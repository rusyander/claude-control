import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitHooksWith } from '../../bootstrap/conductor-wiring/split.ts';
import type { ConductorWiringDeps } from '../../bootstrap/conductor-wiring/conductor-wiring.types.ts';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { estimateTask } from '../estimate/index.ts';
import type { ConductorHooks, StepCtx } from '../run/run.types.ts';
import { presetOf } from '../scenario/index.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { estimateBody, gitRepo, testEnv, type TestEnv } from './__fixtures__/split-stand.ts';

/**
 * Договор плана ведущего (этап 11, W2-9) на настоящем пути: задача создана оценкой на настоящем
 * репозитории, план сдаётся крючком конца шага (`splitHooksWith`, как его зовёт исполнитель),
 * реестр проверок — порт `checksOf` среды деления. Каждый пробел плана назван в ОДНОМ отказе.
 */

const R1 = '0190f0a0-0000-7000-8000-000000000001';
const R2 = '0190f0a0-0000-7000-8000-000000000002';

let root: string;
let registry: TaskRegistry;
let env: TestEnv;
let hooks: ConductorHooks;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-plan-contract-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
  // Реестр профиля репозитория: две узкие проверки.
  env.checksOf = async () => ['unit:web', 'unit:api'];
  hooks = splitHooksWith(
    { registry, layout, note: () => undefined } as unknown as ConductorWiringDeps,
    env,
  );
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const of = <K extends JournalLine['kind']>(task: LiveTask, kind: K): JournalLine<K>[] =>
  readJournalLines(task.dir, task.taskId).lines.filter((l): l is JournalLine<K> => l.kind === kind);

function planDef(preset: string): StepDef {
  const def = presetOf({ id: preset, version: 1 })?.steps.find((s) => s.kind === 'plan');
  if (!def) throw new Error(`${preset} has no plan step`);
  return def;
}

function ctx(task: LiveTask, def: StepDef): StepCtx {
  const unit = Object.keys(task.state.units)[0] ?? '';
  return {
    taskId: task.taskId,
    unitId: unit,
    repoKey: task.state.units[unit]?.repoKey ?? '',
    copyDir: null,
    stepId: newId(),
    def,
    round: 0,
    sessionId: null,
  };
}

async function estimated(name: string, preset: 'lead' | 'feature'): Promise<LiveTask> {
  const repo = gitRepo(root, name, { 'web/page.ts': 'x', 'api/route.ts': 'y' });
  // `auto` — принятое деление запускается сразу: единицы и их роли видны строками `unit.created`.
  const body = estimateBody([repo], { scenario: { preset }, launchPolicy: 'auto' });
  const out = await estimateTask(body, registry, env);
  if (out.status === 422) throw new Error(out.problems.join('; '));
  const task = registry.live(out.reply.taskId);
  if (!task || task.state.task !== 'estimating') throw new Error('not estimating');
  // Требования — строками `requirement.extracted`, как их пишет извлечение (G3).
  [R1, R2].forEach((requirementId, i) =>
    task.append({
      kind: 'requirement.extracted',
      actor: 'core',
      data: {
        requirementId,
        ordinal: i + 1,
        text: `r${i + 1}`,
        source: 'request',
        stepId: null,
      },
    }),
  );
  return task;
}

const claimOf = (stepId: string, units: NonNullable<StepDoneCall['units']>): StepDoneCall => ({
  stepId,
  outcome: 'done',
  requirements: [],
  units,
  summary: 'plan',
});

/** План с тремя пробелами: проверка вне реестра, R2 не покрыт, вход не от зависимости. */
const GAPPED: NonNullable<StepDoneCall['units']> = [
  { name: 'api', ownedPaths: ['api/**'], check: 'unit:nope', role: 'implement', acRefs: [R1] },
  {
    name: 'web',
    ownedPaths: ['web/**'],
    check: 'unit:web',
    role: 'implement',
    inputs: [{ from: 'api', iface: 'ReportApi' }],
  },
];

/** Тот же план, все три пробела закрыты; механика без полной спецификации понижена. */
const FIXED: NonNullable<StepDoneCall['units']> = [
  { name: 'api', ownedPaths: ['api/**'], check: 'unit:api', role: 'implement', acRefs: [R1] },
  {
    name: 'web',
    ownedPaths: ['web/**'],
    deps: ['api'],
    check: 'unit:web',
    role: 'mechanical',
    acRefs: [R2],
    inputs: [{ from: 'api', iface: 'ReportApi' }],
  },
];

describe('lead plan contract through the split hook', () => {
  it('3 gaps → one refusal naming all 3; the fixed plan → accepted, roles on unit.created', async () => {
    const task = await estimated('lead-gapped', 'lead');
    const plan = ctx(task, planDef('lead'));
    const bad = await hooks.postStep?.(plan, claimOf(plan.stepId, GAPPED));
    expect(bad?.verdict).toMatchObject({ ok: false, stop: 'step', code: 'split-refused' });
    const reason = bad?.verdict.ok === false ? bad.verdict.reason : '';
    expect(reason).toMatch(/unknown-check/);
    expect(reason).toMatch(/uncovered-requirement/);
    expect(reason).toMatch(/input-not-dep/);
    expect(of(task, 'split.decided').map((l) => l.data.outcome)).toEqual(['refused']);
    expect(task.state.task).toBe('estimating');

    const good = await hooks.postStep?.(plan, claimOf(plan.stepId, FIXED));
    expect(good?.verdict).toEqual({ ok: true });
    expect(of(task, 'split.decided').map((l) => l.data.outcome)).toEqual(['refused', 'accepted']);
    const decision = of(task, 'decision')
      .filter((l) => (l.data as { class?: string }).class === 'split-check')
      .at(-1)?.data.output as { roles?: Record<string, string>; demoted?: unknown[] };
    // `mechanical` без спецификации — `implement` с названной причиной, не отказ.
    expect(decision.roles).toEqual({ api: 'implement', web: 'implement' });
    expect(decision.demoted).toHaveLength(1);
    const units = of(task, 'unit.created').filter((l) => l.data.splitId !== null);
    expect(units.map((l) => [l.data.name, l.data.role])).toEqual([
      ['api', 'implement'],
      ['web', 'implement'],
    ]);
  });

  it('a task that is not led: the same 3-gap plan is judged by P39 alone and accepted', async () => {
    const task = await estimated('feature-gapped', 'feature');
    const plan = ctx(task, planDef('feature'));
    const done = await hooks.postStep?.(plan, claimOf(plan.stepId, GAPPED));
    expect(done?.verdict).toEqual({ ok: true });
    expect(of(task, 'split.decided').map((l) => l.data.outcome)).toEqual(['accepted']);
  });
});
