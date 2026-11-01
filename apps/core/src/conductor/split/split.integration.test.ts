import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
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
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand, type CommandEnv } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { estimateTask } from '../estimate/index.ts';
import type { ConductorHooks, StepCtx } from '../run/run.types.ts';
import { presetOf } from '../scenario/index.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { unitBaseOf } from '../units/index.ts';
import { estimateBody, g, gitRepo, testEnv, type TestEnv } from './__fixtures__/split-stand.ts';

/**
 * Деление через крючки зоны D (`splitHooksWith`) — так их зовёт исполнитель (зона B): задача
 * создана настоящей оценкой на настоящих репозиториях, шаги — подставные `StepCtx` (исполнителя
 * зоны B ещё нет), команды человека — через вход команд ядра `processCommand`.
 */

let root: string;
let registry: TaskRegistry;
let env: TestEnv;
/** Среда команд, как её даёт API запущенного дирижёра: тот же дом, та же среда деления. */
let cmdEnv: CommandEnv;
let hooks: ConductorHooks;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-split-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
  cmdEnv = commandEnv({ layout, split: env });
  hooks = splitHooksWith(
    { registry, layout, note: () => undefined } as unknown as ConductorWiringDeps,
    env,
  );
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

function command(task: LiveTask, kind: CommandEnvelope['kind'], fields: unknown): CommandEnvelope {
  return {
    cmdId: newId(),
    kind,
    target: { taskId: task.taskId },
    fields: fields as CommandEnvelope['fields'],
    proof: {},
  };
}

const lines = (task: LiveTask): JournalLine[] => readJournalLines(task.dir, task.taskId).lines;
const of = <K extends JournalLine['kind']>(task: LiveTask, kind: K): JournalLine<K>[] =>
  lines(task).filter((l): l is JournalLine<K> => l.kind === kind);

function stepDef(preset: string, kind: StepDef['kind']): StepDef {
  const def = presetOf({ id: preset, version: 1 })?.steps.find((s) => s.kind === kind);
  if (!def) throw new Error(`${preset} has no ${kind} step`);
  return def;
}

function ctx(
  task: LiveTask,
  def: StepDef,
  unitId?: string,
  copyDir: string | null = null,
): StepCtx {
  const unit = unitId ?? Object.keys(task.state.units)[0] ?? '';
  return {
    taskId: task.taskId,
    unitId: unit,
    repoKey: task.state.units[unit]?.repoKey ?? '',
    copyDir,
    stepId: newId(),
    def,
    round: 0,
    sessionId: null,
  };
}

async function estimated(
  repos: string[],
  over: Parameters<typeof estimateBody>[1] = {},
): Promise<LiveTask> {
  const out = await estimateTask(estimateBody(repos, over), registry, env);
  if (out.status === 422) throw new Error(out.problems.join('; '));
  const task = registry.live(out.reply.taskId);
  if (!task || task.state.task !== 'estimating')
    throw new Error(`not estimating: ${out.reply.state}`);
  return task;
}

function claimOf(stepId: string, units: NonNullable<StepDoneCall['units']>): StepDoneCall {
  return { stepId, outcome: 'done', requirements: [], units, summary: 'split proposed' };
}

/**
 * Конец разбора так, как его видит крючок: принятое заявление `step_done` с целями ревью уже
 * строкой `step.claimed` (её пишет `step-done.ts`), то же заявление — аргументом `postStep`.
 */
function intakeClaim(task: LiveTask, s: StepCtx, refs: string[]): StepDoneCall {
  const sessionId = newId();
  const claim: StepDoneCall = {
    stepId: s.stepId,
    outcome: 'done',
    requirements: [],
    reviewTargets: refs.map((ref) => ({ ref })),
    summary: `review targets: ${refs.join(', ')}`,
  };
  task.append({
    kind: 'step.claimed',
    actor: `session:${sessionId}`,
    stepId: s.stepId,
    sessionId,
    data: { stepId: s.stepId, sessionId, claim },
  });
  return claim;
}

describe('split flow', () => {
  it('P95 review-only: two MRs → split offered, awaiting launch, point 10 asked; no unit start before split.decided; one MR → edit refused', async () => {
    const repo = gitRepo(root, 'rev');
    const task = await estimated([repo], { scenario: { preset: 'review-only' } });
    const zero = Object.keys(task.state.units)[0] as string;
    const intake = ctx(task, stepDef('review-only', 'intake'));
    const claim = intakeClaim(task, intake, ['!11', '!12']);
    const done = await hooks.postStep?.(intake, claim);
    expect(done?.verdict).toEqual({ ok: true });

    const proposed = of(task, 'split.proposed');
    expect(proposed.map((l) => l.data.units.map((u) => u.name))).toEqual([
      ['review-1', 'review-2'],
    ]);
    // Единица на цель ревью — предложение ядра по счёту разбора, не плана.
    expect(proposed.map((l) => l.data.by)).toEqual(['core']);
    const splitId = proposed[0]?.data.splitId as string;
    expect(of(task, 'split.decided').map((l) => [l.data.outcome, l.data.by])).toEqual([
      ['accepted', 'core'],
    ]);
    expect(task.state.task).toBe('awaiting-launch');
    expect(env.raised.at(-1)).toMatchObject({
      source: 'launch',
      point: 10,
      dedupe: `split:${splitId}`,
    });
    expect(of(task, 'human.asked')).toHaveLength(1);
    // Ни одна единица деления не создана и не стартовала до решения человека.
    expect(of(task, 'unit.created')).toHaveLength(1);
    expect(of(task, 'unit.transition').filter((l) => l.data.event === 'start')).toEqual([]);
    // Повтор конца шага вне оценки не делит второй раз.
    const before = lines(task).length;
    await hooks.postStep?.(intake, claim);
    expect(lines(task).length).toBe(before);

    // Дирижёр не отдал среду деления (не запущен / остановлен): утверждение отказано, деление
    // не утверждено и задача ждёт, а не идёт мимо предпроверки.
    const noSplit = commandEnv({ layout: cmdEnv.layout });
    const unwired = await processCommand(
      task,
      command(task, 'approve-split', { splitId }),
      proof,
      noSplit,
    );
    expect(unwired).toMatchObject({ status: 'rejected', code: 'preflight-unwired' });
    expect(of(task, 'split.decided').map((l) => l.data.outcome)).toEqual(['accepted']);
    expect(task.state.task).toBe('awaiting-launch');

    const approve = command(task, 'approve-split', { splitId });
    const out = await processCommand(task, approve, proof, cmdEnv);
    expect(out).toMatchObject({ status: 'applied' });
    const received = lines(task).find(
      (l) => l.kind === 'command.received' && l.cmdId === approve.cmdId,
    );
    expect(of(task, 'split.decided').at(-1)).toMatchObject({
      actor: 'human:panel',
      data: { outcome: 'approved', by: 'human', decisionSeq: received?.seq },
    });
    const made = of(task, 'unit.created').slice(1);
    expect(made.map((l) => [l.data.name, l.data.splitId])).toEqual([
      ['review-1', splitId],
      ['review-2', splitId],
    ]);
    expect(task.state.units[zero]?.state).toBe('closed');
    expect(task.state.task).toBe('running');
    const decidedAt = lines(task).findIndex((l) => l.kind === 'split.decided');
    const firstUnit = lines(task).findIndex(
      (l) => l.kind === 'unit.created' && (l as JournalLine<'unit.created'>).data.splitId !== null,
    );
    expect(firstUnit).toBeGreaterThan(decidedAt);

    // Один MR: разбор не предлагает деления (соло), правка человека на две единицы — отказ.
    const one = await estimated([gitRepo(root, 'rev1')], { scenario: { preset: 'review-only' } });
    const oneIntake = ctx(one, stepDef('review-only', 'intake'));
    await hooks.postStep?.(oneIntake, intakeClaim(one, oneIntake, ['!21']));
    const solo = of(one, 'split.proposed')[0]?.data;
    expect(solo?.units.map((u) => u.name)).toEqual(['estimate']);
    const edit = command(one, 'edit-split', {
      splitId: solo?.splitId,
      units: [
        { name: 'a', ownedPaths: ['a/**'], deps: [], repo: null, contract: false },
        { name: 'b', ownedPaths: ['b/**'], deps: [], repo: null, contract: false },
      ],
    });
    // Без среды деления правка не проверяется и не пишется: отказ «не подключено».
    const decidedBefore = of(one, 'split.decided').length;
    const unwiredEdit = await processCommand(
      one,
      { ...edit, cmdId: newId() },
      proof,
      commandEnv({ layout: cmdEnv.layout }),
    );
    expect(unwiredEdit).toMatchObject({ status: 'rejected', code: 'preflight-unwired' });
    expect(of(one, 'split.proposed')).toHaveLength(1);
    expect(of(one, 'split.decided')).toHaveLength(decidedBefore);
    const refused = await processCommand(one, edit, proof, cmdEnv);
    expect(refused).toMatchObject({ status: 'rejected', code: 'split-refused' });
    expect(refused.reason).toMatch(/one-review: one review, no split/);
    expect(of(one, 'split.decided').at(-1)?.data.outcome).toBe('refused');
  });

  it('P76 two repos: contract unit precedes the other repo, units branch from the same-repo predecessor else the pinned base; auto launches', async () => {
    const a = gitRepo(root, 'svc', { 'api/schema.ts': 'x', 'src/main.ts': 'y' });
    const b = gitRepo(root, 'app', { 'app/page.ts': 'z' });
    const task = await estimated([a, b], { launchPolicy: 'auto' });
    const [ra, rb] = task.state.created?.repos ?? [];
    const plan = ctx(task, stepDef('feature', 'plan'));
    const preStep = await hooks.preStep?.(plan);
    expect(preStep?.sections[0]?.text).toMatch(new RegExp(`${ra?.repoKey} = .*${rb?.repoKey} = `));
    const claim = claimOf(plan.stepId, [
      { name: 'web', repo: b, ownedPaths: ['app/**'] },
      { name: 'server', repo: ra?.repoKey, ownedPaths: ['src/**'], deps: ['contract'] },
      { name: 'contract', repo: ra?.repoKey, ownedPaths: ['api/**'], contract: true },
    ]);
    const done = await hooks.postStep?.(plan, claim);
    expect(done?.verdict).toEqual({ ok: true });
    expect(done?.facts).toMatchObject({ then: 'launched' });
    expect(task.state.task).toBe('running');
    const preflight = of(task, 'signal').filter((l) => l.data.signal === 'preflight');
    expect(preflight.map((l) => l.data.subject)).toEqual(['estimate', 'launch']);
    // Решение старшинства (G1, P80) пишут и оценка, и запуск — над тем же сценарием, тот же итог.
    const precedence = of(task, 'decision').filter(
      (l) => (l.data as { class?: string }).class === 'precedence',
    );
    expect(precedence).toHaveLength(2);
    expect(precedence[1]?.data).toMatchObject({
      class: 'precedence',
      numbers: (precedence[0]?.data as { numbers: unknown }).numbers,
    });
    expect(precedence[1]?.seq).toBeGreaterThan(preflight[1]?.seq ?? Infinity);

    const units = of(task, 'unit.created')
      .slice(1)
      .map((l) => l.data);
    const byName = Object.fromEntries(units.map((u) => [u.name, u]));
    const order = units.map((u) => u.name);
    expect(order.indexOf('contract')).toBeLessThan(order.indexOf('web'));
    expect(order.indexOf('contract')).toBeLessThan(order.indexOf('server'));
    expect(byName.web?.after).toEqual([byName.contract?.unitId]);
    expect(byName.server?.after).toEqual([byName.contract?.unitId]);
    expect(byName.web?.repoKey).toBe(rb?.repoKey);
    const repos = task.state.created?.repos ?? [];
    expect(unitBaseOf(byName.server as never, units, repos)).toEqual({
      kind: 'predecessor',
      unitId: byName.contract?.unitId,
      branch: byName.contract?.branch,
    });
    expect(unitBaseOf(byName.web as never, units, repos)).toEqual({
      kind: 'base',
      repoKey: rb?.repoKey,
      ref: g(b, 'rev-parse', 'origin/main'),
      sha: g(b, 'rev-parse', 'origin/main'),
    });

    // Суд владения после шага работы: правка вне своих путей — решение, сигнал и строка брифа.
    const contractId = byName.contract?.unitId as string;
    writeFileSync(join(a, 'src', 'main.ts'), 'edited outside');
    writeFileSync(join(a, 'api', 'schema.ts'), 'edited inside');
    const work = ctx(task, stepDef('feature', 'work'), contractId, a);
    const judged = await hooks.postStep?.(work, null);
    expect(judged?.facts).toEqual({ ownership: 'outside', outside: 1 });
    expect(
      of(task, 'signal')
        .filter((l) => l.data.signal === 'ownership')
        .map((l) => l.data.detail),
    ).toEqual(['src/main.ts']);
    const brief = await hooks.preStep?.(ctx(task, stepDef('feature', 'review'), contractId, a));
    expect(brief?.sections[0]?.text).toMatch(/api\/\*\*/);
    expect(brief?.sections[0]?.text).toMatch(/src\/main\.ts/);
  });

  it('P39 P101 refused proposal stops the plan step naming every problem; launch with a road down is refused, the launch command after the fix is an implicit approval', async () => {
    const repo = gitRepo(root, 'mono', { 'src/a.ts': '1' });
    const task = await estimated([repo]);
    const plan = ctx(task, stepDef('feature', 'plan'));
    const bad = await hooks.postStep?.(
      plan,
      claimOf(plan.stepId, [
        { name: 'x', ownedPaths: ['src/**'], deps: ['y'] },
        { name: 'y', ownedPaths: ['src/a.ts'], deps: ['x'] },
        { name: 'z', ownedPaths: ['lib/**'], deps: ['nope'] },
      ]),
    );
    expect(bad?.verdict).toMatchObject({ ok: false, stop: 'step', code: 'split-refused' });
    const reason = bad?.verdict.ok === false ? bad.verdict.reason : '';
    expect(reason).toMatch(/unknown-dep/);
    expect(reason).toMatch(/cycle/);
    expect(task.state.task).toBe('estimating');
    expect(of(task, 'split.decided').map((l) => l.data.outcome)).toEqual(['refused']);

    // Второе предложение годно, но дорога упала, пока ждали: запуск отказан, задача ждёт.
    const good = claimOf(plan.stepId, [
      { name: 'x', ownedPaths: ['src/**'] },
      { name: 'z', ownedPaths: ['lib/**'] },
    ]);
    await hooks.postStep?.(plan, good);
    expect(task.state.task).toBe('awaiting-launch');
    env.roads = { 'repo-access': { status: 'fail', detail: 'folder gone', fix: 'restore it' } };
    try {
      const launch = await processCommand(task, command(task, 'launch', {}), proof, cmdEnv);
      expect(launch).toMatchObject({ status: 'rejected', code: 'preflight-failed' });
      expect(launch.reason).toMatch(/repo-access: folder gone — fix: restore it/);
      expect(task.state.task).toBe('awaiting-launch');
    } finally {
      env.roads = {};
    }
    // Дирижёр не запущен: запуск ждущей задачи отказан `preflight-unwired`, единиц нет.
    const unwired = await processCommand(
      task,
      command(task, 'launch', {}),
      proof,
      commandEnv({ layout: cmdEnv.layout }),
    );
    expect(unwired).toMatchObject({ status: 'rejected', code: 'preflight-unwired' });
    expect(task.state.task).toBe('awaiting-launch');
    expect(of(task, 'unit.created')).toHaveLength(1);
    const launched = await processCommand(task, command(task, 'launch', {}), proof, cmdEnv);
    expect(launched).toMatchObject({ status: 'applied', outcome: { to: 'running' } });
    expect(
      of(task, 'unit.created')
        .slice(1)
        .map((l) => l.data.name),
    ).toEqual(['x', 'z']);
  });
});
