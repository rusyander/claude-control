import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journaledSetup, unitCopyOf } from '../../conductor/copy/index.ts';
import { installer, makeRepo } from '../../conductor/copy/__fixtures__/copy-harness.ts';
import type { RedBeforeDecision } from '../../conductor/outcomes/index.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import {
  CREATED,
  openFresh,
  SOLO_UNIT,
  tempDir,
} from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { ensureCoreHome, type CoreHomeLayout } from '../../platform/core-home.ts';
import { findVitestEntry } from '../../verifier/mutate/vitest-runner.ts';
import { profileOf } from '../../verifier/profile/index.ts';
import { copyWiring } from '../copy-wiring.ts';
import { buildVerifierWiring, type VerifierWiring } from '../verifier-wiring/index.ts';
import { readPinnedProfile } from '../verifier-wiring/pinned-profile.ts';
import { copyProfileDeps } from '../verifier-wiring/queue.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { createWiringHooks } from './wiring.ts';

/**
 * Обвязка шага зоны F на настоящем пути: временный git-репозиторий с багом и реестром
 * `.agentdeck/checks.json` (раннер — настоящий vitest рабочей области), дом ядра во временной
 * папке, настоящая обвязка проверок `buildVerifierWiring`, настоящая копия-worktree, живая задача в
 * журнале. Подменены только внешние границы: установщик пакетов (сеть реестра) и свободное место
 * диска (ОС). Свойства идут по порядку жизни единицы и делят одну сцену.
 */

const VITEST = findVitestEntry(dirname(fileURLToPath(import.meta.url)));
const RUN = [process.execPath, VITEST ?? 'vitest', 'run'];
const FLAGS = ['--globals', '--root', '.', '--reporter=verbose'];
const CHECKS = {
  v: 1,
  checks: [
    {
      id: 'tests',
      class: 'test-runner',
      argv: [...RUN, '{files}', ...FLAGS],
      requiredAt: ['publish', 'deliver'],
      filter: { kind: 'vitest', argv: [...RUN, '{files}', ...FLAGS, '-t', '{tests}'] },
    },
  ],
};
const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const REGRESSION =
  "import { add } from '../src/add.mjs';\ndescribe('add', () => { it('sums', () => { expect(add(1, 2)).toBe(3); }); });\n";

const def = (kind: string, over: Partial<StepDef> = {}): StepDef =>
  ({ id: kind, kind, gate: [], ...over }) as unknown as StepDef;
const DONE = { outcome: 'done' } as unknown as StepDoneCall;
const ROOMY = async () => ({ value: { freeBytes: 500e9, totalBytes: 1e12 } });

interface Stand {
  root: string;
  repo: string;
  home: CoreHomeLayout;
  task: LiveTask;
  unitId: string;
  pin: string;
  verifier: VerifierWiring;
  deps: ConductorWiringDeps;
  ins: ReturnType<typeof installer>;
  jobs: Promise<unknown>[];
  notes: [string, Record<string, unknown>][];
  hooks: ReturnType<typeof createWiringHooks>;
}

let s: Stand;

function transition(
  task: LiveTask,
  kind: 'task.transition' | 'unit.transition' | 'step.transition',
  id: string,
  event: string,
  from: string,
  to: string,
): void {
  const key = {
    'task.transition': 'taskId',
    'unit.transition': 'unitId',
    'step.transition': 'stepId',
  }[kind];
  task.append({
    kind,
    actor: 'core',
    ...(kind === 'unit.transition' ? { unitId: id } : {}),
    ...(kind === 'step.transition' ? { stepId: id } : {}),
    data: { [key]: id, event, from, to },
  } as never);
}

function startStep(kind: string): StepCtx & { stepId: string } {
  const stepId = newId();
  s.task.append({
    kind: 'step.started',
    actor: 'core',
    unitId: s.unitId,
    stepId,
    data: {
      stepId,
      unitId: s.unitId,
      stepKind: kind,
      stepDefId: kind,
      round: 0,
      scenario: CREATED.scenario,
      budgetMs: 600_000,
    },
  });
  transition(s.task, 'step.transition', stepId, 'start', 'queued', 'running');
  return {
    taskId: s.task.taskId,
    unitId: s.unitId,
    repoKey: 'r1',
    copyDir: unitCopyOf(s.task, s.unitId)?.dir ?? null,
    stepId,
    def: def(kind),
    round: 0,
    sessionId: null,
  };
}

function finishStep(stepId: string): void {
  transition(s.task, 'step.transition', stepId, 'check', 'running', 'checking');
  transition(s.task, 'step.transition', stepId, 'checked-green', 'checking', 'done');
}

function lines(kind: string): { data: Record<string, unknown> }[] {
  return readJournalLines(s.task.dir, s.task.taskId).lines.filter(
    (l) => l.kind === kind,
  ) as unknown as { data: Record<string, unknown> }[];
}

function copyDir(): string {
  const dir = unitCopyOf(s.task, s.unitId)?.dir;
  if (!dir) throw new Error('no copy');
  return dir;
}

beforeAll(async () => {
  expect(VITEST).toBeDefined();
  const root = tempDir('wire-f-');
  const { repo } = makeRepo({
    '.agentdeck/checks.json': `${JSON.stringify(CHECKS)}\n`,
    'src/add.mjs': BUGGY,
  });
  const home = ensureCoreHome(join(root, 'home'));
  // Пин — профиль основной папки на старте задачи, как его кладёт создание задачи (G21).
  const pinned = await profileOf({ repoKey: 'r1', path: repo }, copyProfileDeps(home.profiles));
  if (!('value' in pinned)) throw new Error(`profile: ${JSON.stringify(pinned)}`);
  const { task } = await openFresh(join(root, 'tasks'));
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      repos: [{ repoKey: 'r1', path: repo, baseRef: 'main' }],
      profilePins: [{ repoKey: 'r1', inputsFp: pinned.value.inputsFp }],
    },
  });
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  transition(task, 'task.transition', task.taskId, 'estimate', 'draft', 'estimating');
  const registry = {
    live: (id: string) => (id === task.taskId ? task : undefined),
  } as unknown as TaskRegistry;
  const verifier = buildVerifierWiring({ registry, layout: home });
  const notes: Stand['notes'] = [];
  const deps: ConductorWiringDeps = {
    registry,
    layout: home,
    verifier,
    road: {} as ConductorWiringDeps['road'],
    note: (event, data) => notes.push([event, data]),
  };
  const ins = installer();
  const jobs: Promise<unknown>[] = [];
  const hooks = createWiringHooks(deps, {
    copy: copyWiring({
      registry,
      layout: home,
      profileOf: verifier.profile.profileOf,
      root: join(root, 'copies'),
      install: ins.install,
      env: async () => ({ PATH: process.env.PATH ?? '' }),
    }),
    diskFree: ROOMY,
    background: (job) => jobs.push(job),
    outcomes: { pollMs: 50, waitMs: 120_000 },
  });
  s = {
    root,
    repo,
    home,
    task,
    unitId,
    pin: pinned.value.inputsFp,
    verifier,
    deps,
    ins,
    jobs,
    notes,
    hooks,
  };
}, 60_000);

afterAll(async () => {
  // Ранний прогон итога идёт в фоне: под `-t` его никто не дождался, а живой vitest держит
  // каталог копии — Windows не даст его удалить (EBUSY). Сначала дождаться, потом убирать.
  if (s) await Promise.allSettled(s.jobs);
  s?.task.close();
  if (s) rmSync(s.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 240_000);

/**
 * Сцена — по стадиям жизни единицы, каждая один раз (память промисом): свойство под `-t` (прогон
 * одного кейса, мутант) доигрывает нужные стадии само, порядок файла ничего не решает. Стадия
 * снимает свои числа в момент, когда они видны, — свойство сверяет снимок, а не позднее состояние.
 */
const once = <T>(run: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= run());
};

const unitCtx = () => ({
  taskId: s.task.taskId,
  unitId: s.unitId,
  repoKey: 'r1',
  copyDir: unitCopyOf(s.task, s.unitId)?.dir ?? null,
});

const started = once(async () => {
  const got = await s.hooks.onUnitStart!(unitCtx());
  return {
    got,
    calls: s.ins.calls.length,
    deferred: journaledSetup(s.task, s.unitId)?.installDeferred,
    snapshot: readPinnedProfile(s.home.profiles, s.pin)?.inputsFp,
  };
});

const worked = once(async () => {
  await started();
  transition(
    s.task,
    'task.transition',
    s.task.taskId,
    'estimated',
    'estimating',
    'awaiting-launch',
  );
  transition(s.task, 'task.transition', s.task.taskId, 'launch', 'awaiting-launch', 'running');
  transition(s.task, 'unit.transition', s.unitId, 'start', 'planned', 'running');
  const look = startStep('research');
  const read = await s.hooks.preStep!(look);
  const afterRead = s.ins.calls.length;
  finishStep(look.stepId);
  const work = startStep('work');
  const edit = await s.hooks.preStep!(work);
  const afterEdit = s.ins.calls.length;
  const deferred = journaledSetup(s.task, s.unitId)?.installDeferred;
  const again = await s.hooks.preStep!({ ...work, stepId: newId() });
  const afterAgain = s.ins.calls.length;
  // Работа шага: фикс бага и тест регрессии в копии.
  writeFileSync(join(copyDir(), 'src', 'add.mjs'), FIXED);
  mkdirSync(join(copyDir(), 'test'), { recursive: true });
  writeFileSync(join(copyDir(), 'test', 'add.test.mjs'), REGRESSION);
  finishStep(work.stepId);
  return { read, afterRead, edit, afterEdit, deferred, again, afterAgain, work };
});

const redBefore = once(async () => {
  const { work } = await worked();
  const ctx: StepCtx = {
    ...work,
    def: def('work', {
      regression: { checkId: 'tests' },
      gate: [{ kind: 'regression-red-before' }] as StepDef['gate'],
    }),
  };
  const decided = () => lines('decision').filter((l) => l.data.class === 'red-before');
  const proven = await s.hooks.postStep!(ctx, DONE);
  const afterProven = decided();
  const plain = await s.hooks.postStep!(work, DONE);
  const afterPlain = decided().length;
  // Ворота «красный до» без доказательства (тест регрессии не из реестра) — шаг стоит с причиной.
  const unproven = await s.hooks.postStep!(
    { ...ctx, def: { ...ctx.def, regression: { checkId: 'missing' } } },
    DONE,
  );
  return { proven, plain, unproven, afterProven, afterPlain, afterUnproven: decided() };
});

const moved = once(async () => {
  await redBefore();
  writeFileSync(join(copyDir(), 'package.json'), '{"name":"p","version":"2.0.0"}\n');
  const extra = {
    ...CHECKS,
    checks: [
      ...CHECKS.checks,
      { id: 'extra', class: 'static', argv: ['node', '-e', '0'], requiredAt: ['publish'] },
    ],
  };
  writeFileSync(join(copyDir(), '.agentdeck', 'checks.json'), `${JSON.stringify(extra)}\n`);
  const review = startStep('review');
  const first = await s.hooks.preStep!(review);
  const jobsAfterFirst = s.jobs.length;
  const second = await s.hooks.preStep!(review);
  const jobsAfterSecond = s.jobs.length;
  const signals = lines('signal').filter((l) => l.data.signal === 'profile-moved');
  const parts = await s.verifier.queue.parts();
  if (!('value' in parts)) throw new Error('verifier parts');
  const reg = await parts.value.deps.registry({
    road: 'conductor',
    origin: 'core',
    taskId: s.task.taskId,
    stepId: null,
    project: 'r1',
    copyDir: copyDir(),
    class: 'deliver',
    phase: 'final',
    checkId: 'tests',
    unit: '.',
    changedUnits: [],
    exec: 'core',
  });
  return { review, first, second, jobsAfterFirst, jobsAfterSecond, signals, reg };
});

const gated = once(async () => {
  const { review } = await moved();
  await Promise.all(s.jobs);
  const pre = s.notes.filter(([e]) => e === 'wiring.pre-run');
  finishStep(review.stepId);
  // Блок тестов лежит в ИСХОДНОМ репозитории (в копию `.agent/` не попадает): кейс называет `src/`.
  mkdirSync(join(s.repo, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(s.repo, '.agent', 'tests', 'core.tests.json'),
    JSON.stringify({ version: 1, cases: [{ id: 'core-001', codePaths: ['src'] }] }),
  );
  const gate = await s.hooks.onFinalGate!({ ...unitCtx(), copyDir: copyDir() });
  const compose = lines('decision').filter((l) => l.data.class === 'compose');
  return { pre, gate, compose };
});

const ended = once(async () => {
  await gated();
  const dir = copyDir();
  const end = () => s.hooks.onUnitEnd!({ ...unitCtx(), copyDir: dir });
  const kept = () => s.notes.filter(([e]) => e === 'wiring.copy-kept').map(([, d]) => d.why);
  // Единица ещё в работе — копию не трогают и не жалуются.
  await end();
  const running = { exists: existsSync(dir), kept: kept() };
  transition(s.task, 'unit.transition', s.unitId, 'close', 'running', 'closed');
  await end();
  const dirty = { exists: existsSync(dir), kept: kept() };
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix'],
    {
      stdio: 'ignore',
    },
  );
  await end();
  const clean = { exists: existsSync(dir), kept: kept() };
  return { running, dirty, clean };
});

describe('step wiring of zone F on a real repo, copy, verifier and journal', () => {
  it('estimating unit start lays the copy without install, names the deferral and snapshots the pinned profile', async () => {
    const { got, calls, deferred, snapshot } = await started();
    expect(got.verdict).toEqual({ ok: true });
    expect(existsSync(copyDir())).toBe(true);
    expect(calls).toBe(0);
    expect(deferred).toBe(true);
    expect(got.sections.map((x) => x.id)).toEqual(['copy-setup']);
    expect(got.sections[0]?.text).toMatch(/deferred until the first step that edits the copy/);
    expect(snapshot).toBe(s.pin);
  }, 120_000);

  it('the first step that edits the copy delivers the deferred install once; a read-only step does not', async () => {
    const w = await worked();
    expect(w.read.sections).toEqual([]);
    expect(w.afterRead).toBe(0);
    expect(w.edit.verdict).toEqual({ ok: true });
    expect(w.afterEdit).toBe(1);
    expect(w.deferred).toBeUndefined();
    expect(w.edit.sections.map((x) => x.id)).toEqual(['copy-setup']);
    expect(w.afterAgain).toBe(1);
    expect(w.again.sections).toEqual([]);
  }, 120_000);

  it('postStep of a bug-fix work step proves red-before: the fix test fails on the pinned base and passes on the copy', async () => {
    const { proven, plain, unproven } = await redBefore();
    const rb = proven.facts.redBefore as RedBeforeDecision;
    expect(rb.tests).toEqual([{ file: 'test/add.test.mjs', name: 'add > sums' }]);
    expect(rb.unknown).toEqual([]);
    expect(rb.results.map((r) => [r.test, r.outcome])).toEqual([['add > sums', 'proven']]);
    expect(rb.proven).toBe(true);
    expect(proven.verdict).toEqual({ ok: true });
    // Без регрессии в определении шага — крючок молчит.
    expect(plain.facts).toEqual({});
    expect(unproven.verdict).toEqual({
      ok: false,
      stop: 'step',
      code: 'red-before-unproven',
      reason: 'regression check missing is not in the registry',
    });
    expect(unproven.facts).toEqual({
      redBefore: { unknown: 'regression check missing is not in the registry' },
    });
  }, 240_000);

  it('red-before is journaled as a decision of class red-before: proven, silent without regression, unknown named', async () => {
    const { afterProven, afterPlain, afterUnproven } = await redBefore();
    expect(afterProven).toHaveLength(1);
    expect(afterProven[0]?.data).toMatchObject({
      class: 'red-before',
      numbers: { tests: 1, proven: 1, unknown: 0, gated: 1 },
      reasons: ['proven', 'add > sums: proven'],
      facts: [
        { readClass: 'check.registry', kind: 'value' },
        { readClass: 'check.records', kind: 'value' },
      ],
      output: { checkId: 'tests', proven: true },
    });
    // Шаг без регрессии — решения нет.
    expect(afterPlain).toBe(1);
    expect(afterUnproven).toHaveLength(2);
    expect(afterUnproven[1]?.data).toMatchObject({
      class: 'red-before',
      numbers: { tests: 0, proven: 0, gated: 1 },
      reasons: ['unknown: regression check missing is not in the registry'],
      facts: [
        { readClass: 'check.registry', kind: 'unknown' },
        { readClass: 'check.records', kind: 'unknown' },
      ],
    });
  }, 240_000);

  it('profile moved against the pin: one profile-moved signal per new fingerprint, a brief section every step, the registry stays pinned', async () => {
    const m = await moved();
    for (const got of [m.first, m.second]) {
      expect(got.sections.map((x) => x.id)).toEqual(['profile']);
      expect(got.sections[0]?.text).toMatch(/changed since the task started/);
    }
    expect(m.signals).toHaveLength(1);
    expect(m.signals[0]?.data.detail).toMatch(new RegExp(`^pinned ${s.pin} → [0-9a-f]{64}$`));
    expect('value' in m.reg && m.reg.value.checks.map((c) => c.id)).toEqual(['tests']);
  }, 240_000);

  it('a read-only step after done work pre-runs the final checks once in the background; the final gate replays them and runs nothing', async () => {
    const m = await moved();
    expect(m.jobsAfterFirst).toBe(1);
    expect(m.jobsAfterSecond).toBe(1);
    const g = await gated();
    expect(g.pre).toHaveLength(1);
    expect(g.pre[0]?.[1]).toMatchObject({ answers: 1 });
    expect(g.gate.verdict).toEqual({ ok: true });
    expect(g.gate.compositionId).toEqual(expect.any(String));
    expect(g.compose).toHaveLength(1);
    expect(g.compose[0]?.data.reasons).toEqual(['ready']);
    expect(g.compose[0]?.data.numbers).toMatchObject({ ran: 0, units: 1, unmet: 0 });
    // Карта покрытия прочитана из блока тестов исходного репозитория: изменённый `src/add.mjs`
    // покрыт кейсом и пробелом не назван (G18).
    const output = g.compose[0]?.data.output as { coverageGaps?: string[] } | undefined;
    expect(output?.coverageGaps).toBeDefined();
    expect(output?.coverageGaps).not.toContain('src/add.mjs');
  }, 240_000);

  it('unit end removes the copy of a closed unit only; uncommitted work keeps it and is named', async () => {
    const e = await ended();
    expect(e.running).toEqual({ exists: true, kept: [] });
    expect(e.dirty).toEqual({
      exists: true,
      kept: [
        'uncommitted work in the copy: .agentdeck/checks.json, package.json, src/add.mjs, test/add.test.mjs',
      ],
    });
    expect(e.clean.exists).toBe(false);
    expect(e.clean.kept).toHaveLength(1);
  }, 240_000);

  it('low disk stops a unit before a new copy is laid out; unknown free space lays it out and says so', async () => {
    await worked();
    const unitId = newId();
    s.task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: {
        unitId,
        repoKey: 'r1',
        branch: `agentdeck/${unitId.slice(-8)}`,
        ownedPaths: [],
        ...SOLO_UNIT,
      },
    });
    const ctx = { taskId: s.task.taskId, unitId, repoKey: 'r1', copyDir: null };
    const low = createWiringHooks(s.deps, {
      diskFree: async () => ({ value: { freeBytes: 1_000, totalBytes: 1e12 } }),
    });
    const got = await low.onUnitStart!(ctx);
    expect(got.verdict).toMatchObject({ ok: false, stop: 'unit', code: 'disk-low' });
    expect(unitCopyOf(s.task, unitId)).toBeUndefined();

    const ins = installer();
    const doubt = createWiringHooks(s.deps, {
      copy: copyWiring({
        registry: s.deps.registry,
        layout: s.home,
        profileOf: s.verifier.profile.profileOf,
        root: join(s.root, 'copies'),
        install: ins.install,
        env: async () => ({ PATH: process.env.PATH ?? '' }),
      }),
      diskFree: async () => ({ unknown: 'statfs refused' }),
    });
    const laid = await doubt.onUnitStart!(ctx);
    expect(laid.verdict).toEqual({ ok: true });
    expect(laid.sections[0]).toMatchObject({
      id: 'copy-setup',
      text: expect.stringMatching(/^Free disk space is unknown \(statfs refused\)/),
    });
    expect(unitCopyOf(s.task, unitId)).toBeDefined();
    expect(ins.calls).toHaveLength(1);
  }, 120_000);
});
