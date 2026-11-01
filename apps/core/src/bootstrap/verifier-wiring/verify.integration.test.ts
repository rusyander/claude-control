import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { addDetachedWorktree, commonDirSync } from '../../platform/git.ts';
import { runTool } from '../../platform/run-tool.ts';
import { fixtureRegistry } from '../../verifier/__fixtures__/registry.ts';
import { decideCheck } from '../../verifier/decide/index.ts';
import { absentKeyOf } from '../../verifier/key/index.ts';
import {
  absentRecordDraft,
  createRecordStore,
  loadVerifyKey,
  storeRoot,
  type RecordDraft,
} from '../../verifier/store/index.ts';
import { verifyWiring } from './verify.ts';

/**
 * Записи проверок на настоящем git (04:33, P08): основная папка и её копия-worktree делят одно
 * хранилище; `records(id)` у `step_done` отдаёт вердикт записи из любой из них, правленая запись —
 * `unknown`, чужой номер — `absent`. Дом ядра и репозитории — во временной папке.
 */

let root: string;
let main: string;
let copy: string;
let home: string;

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const run = await runTool('git', ['-C', cwd, ...args], { timeoutMs: 30_000 });
  if (!run.ok) throw new Error(`git ${args.join(' ')}: ${run.reason}`);
}

/** Задача, что спрашивает `records`: её репозитории — единственные, где ищется запись. */
const TASK = '0192f000-0000-7000-8000-0000000000a0';

function liveWith(...paths: string[]): Pick<TaskRegistry, 'liveTasks'> {
  const repos = paths.map((path, i) => ({ repoKey: `r${i}`, path, baseRef: 'main' }));
  return {
    liveTasks: () =>
      [{ taskId: TASK, state: { created: { repos } } }] as unknown as ReturnType<
        TaskRegistry['liveTasks']
      >,
  };
}

// Ключ, единица и выборка записи — для суда свежести и охвата у step_done (G22, P92).
const TREE = { key: expect.stringMatching(/^[0-9a-f]{64}$/), unit: '', selection: [] };

const facts = (verdict: string) => ({
  value: { verdict, checkId: 'tests', taskId: TASK, origin: 'core', ...TREE },
});

function draft(over: Partial<RecordDraft> = {}): RecordDraft {
  return {
    ...absentRecordDraft({
      checkId: 'tests',
      registry: fixtureRegistry(),
      startedAt: 1_000,
      origin: 'core',
      checkRunId: null,
      taskId: null,
    }),
    ...over,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'core-verify-wiring-'));
  main = join(root, 'main');
  copy = join(root, 'copy');
  home = join(root, 'home');
  mkdirSync(main);
  await sh(main, 'init', '-q', '-b', 'main');
  await sh(main, 'config', 'user.email', 't@example.com');
  await sh(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  await sh(main, 'add', '-A');
  await sh(main, 'commit', '-q', '-m', 'init');
  const added = await addDetachedWorktree(main, copy, 'HEAD');
  if (!('created' in added)) throw new Error(added.failed);
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('verify wiring on real git', () => {
  it('P08 main and its worktree copy share one store; step_done sees every verdict by name, a foreign id is absent', () => {
    const mainCommon = commonDirSync(main);
    const copyCommon = commonDirSync(copy);
    expect(copyCommon).toEqual(mainCommon);
    if (!('value' in mainCommon)) throw new Error('no common dir');
    const key = loadVerifyKey(home);
    if (!('value' in key)) throw new Error('no key');
    const store = createRecordStore({ root: storeRoot(mainCommon.value), key: key.value });

    const verdicts: CheckRecord['verdict'][] = [
      { kind: 'pass' },
      { kind: 'fail', reason: 'red' },
      { kind: 'no-verdict', reason: 'aborted' },
    ];
    const ids = verdicts.map((verdict, i) => {
      const id = store.write(draft({ verdict, startedAt: 1_000 + i, taskId: TASK }), 'log');
      if (!('value' in id)) throw new Error(JSON.stringify(id));
      return id.value;
    });
    const flaky = store.write(
      draft({
        verdict: { kind: 'pass-flaky', retries: [ids[1] as string] },
        startedAt: 9_000,
        taskId: TASK,
      }),
      '',
    );
    if (!('value' in flaky)) throw new Error(JSON.stringify(flaky));

    // Задача держит только копию: хранилище находится через её общий каталог git.
    const wiring = verifyWiring({ registry: liveWith(copy), layout: { root: home } });
    expect([...ids, flaky.value].map((id) => wiring.records(id, TASK))).toEqual([
      facts('pass'),
      facts('fail'),
      facts('no-verdict'),
      facts('pass-flaky'),
    ]);
    expect(wiring.records(`${'0'.repeat(64)}.0`, TASK)).toEqual({ absent: true });
    expect(wiring.records('not-a-record-id', TASK)).toEqual({ absent: true });
    // Без живых задач хранилищ нет: номер — `absent`, ключ подписи не читается вовсе.
    expect(verifyWiring({ registry: {}, layout: {} }).records(ids[0] as string, TASK)).toEqual({
      absent: true,
    });
  });

  it('P06 a hand-edited record read through the wiring is unknown, never its forged verdict; a missing core home is unknown', () => {
    const common = commonDirSync(main);
    const key = loadVerifyKey(home);
    if (!('value' in common) || !('value' in key)) throw new Error('setup');
    const store = createRecordStore({ root: storeRoot(common.value), key: key.value });
    const id = store.write(
      draft({ verdict: { kind: 'fail', reason: 'red' }, startedAt: 20_000 }),
      '',
    );
    if (!('value' in id)) throw new Error('write');
    const file = join(store.root, 'records', id.value.slice(0, 2), `${id.value}.json`);
    const forged = { ...JSON.parse(readFileSync(file, 'utf8')), verdict: { kind: 'pass' } };
    rmSync(file);
    writeFileSync(file, JSON.stringify(forged));
    const wiring = verifyWiring({ registry: liveWith(main), layout: { root: home } });
    expect(wiring.records(id.value, TASK)).toEqual({
      unknown: expect.stringContaining('bad signature'),
    });
    expect(verifyWiring({ registry: liveWith(main), layout: {} }).records(id.value, TASK)).toEqual({
      unknown: 'verify key: core home not laid out',
    });
  });

  it('records(id, taskId) reads only the asking task stores, names no foreign repo path and carries the binding facts', async () => {
    const key = loadVerifyKey(home);
    const common = commonDirSync(main);
    if (!('value' in common) || !('value' in key)) throw new Error('setup');
    const own = '0192f000-0000-7000-8000-0000000000a1';
    const foreign = '0192f000-0000-7000-8000-0000000000b2';
    const id = createRecordStore({ root: storeRoot(common.value), key: key.value }).write(
      draft({ verdict: { kind: 'pass' }, startedAt: 40_000, taskId: own, origin: 'core' }),
      '',
    );
    if (!('value' in id)) throw new Error(JSON.stringify(id));
    // Репозиторий другой задачи: его зелёная запись и правленая запись — не для этой задачи.
    const foreignRepo = join(root, 'foreign-secret-repo');
    mkdirSync(foreignRepo);
    await sh(foreignRepo, 'init', '-q', '-b', 'main');
    const foreignCommon = commonDirSync(foreignRepo);
    if (!('value' in foreignCommon)) throw new Error('foreign common dir');
    const foreignStore = createRecordStore({
      root: storeRoot(foreignCommon.value),
      key: key.value,
    });
    // Своя проверка — свой ключ: номер записи `<key>.<attempt>` не совпадёт с номером в хранилище задачи.
    const theirsDraft = (startedAt: number): RecordDraft =>
      absentRecordDraft({
        checkId: 'theirs',
        registry: fixtureRegistry(),
        startedAt,
        origin: 'core',
        checkRunId: null,
        taskId: foreign,
      });
    const theirs = foreignStore.write({ ...theirsDraft(41_000), verdict: { kind: 'pass' } }, '');
    const forged = foreignStore.write(theirsDraft(42_000), '');
    if (!('value' in theirs) || !('value' in forged)) throw new Error('foreign write');
    const forgedFile = join(
      foreignStore.root,
      'records',
      forged.value.slice(0, 2),
      `${forged.value}.json`,
    );
    const body = { ...JSON.parse(readFileSync(forgedFile, 'utf8')), verdict: { kind: 'pass' } };
    rmSync(forgedFile);
    writeFileSync(forgedFile, JSON.stringify(body));
    const registry: Pick<TaskRegistry, 'liveTasks'> = {
      liveTasks: () =>
        [
          { taskId: own, state: { created: { repos: [{ repoKey: 'r0', path: copy }] } } },
          {
            taskId: foreign,
            state: { created: { repos: [{ repoKey: 'r1', path: foreignRepo }] } },
          },
        ] as unknown as ReturnType<TaskRegistry['liveTasks']>,
    };
    const wiring = verifyWiring({ registry, layout: { root: home } });
    expect(wiring.records(id.value, own)).toEqual({
      value: { verdict: 'pass', checkId: 'tests', taskId: own, origin: 'core', ...TREE },
    });
    // Записи чужой задачи в её хранилище для этой задачи нет; путь её репозитория модели не уходит.
    expect(wiring.records(theirs.value, own)).toEqual({ absent: true });
    const missing = wiring.records(forged.value, own);
    expect(missing).toEqual({ absent: true });
    expect(JSON.stringify(missing)).not.toContain('foreign-secret-repo');
  });

  it('G3 an absent check: decide asks for the fail{absent} record, the store keeps it, decide then answers absent with it', () => {
    const common = commonDirSync(copy);
    const key = loadVerifyKey(home);
    if (!('value' in common) || !('value' in key)) throw new Error('setup');
    const store = createRecordStore({ root: storeRoot(common.value), key: key.value });
    const registry = fixtureRegistry();
    const absentKey = absentKeyOf('nope', registry).key;
    const ask = (records: CheckRecord[]) =>
      decideCheck({
        road: 'model-tool',
        entry: null,
        unit: '',
        selection: [],
        blockers: [],
        key: { value: absentKey },
        records: { value: records },
        inflight: null,
        phase: 'final',
        changedUnits: [],
        window: { verdict: 'open', basis: 'economy-window' },
        fresh: null,
        quarantined: [],
      });
    const before = store.byKey(absentKey);
    if (!('value' in before)) throw new Error('read');
    expect(ask(before.value)).toMatchObject({ kind: 'run', reason: /^absent-unrecorded/ });
    const written = store.write(
      absentRecordDraft({
        checkId: 'nope',
        registry,
        startedAt: 30_000,
        origin: 'core',
        checkRunId: null,
        taskId: null,
      }),
      '',
    );
    if (!('value' in written)) throw new Error(JSON.stringify(written));
    const after = store.byKey(absentKey);
    if (!('value' in after)) throw new Error('read');
    expect(ask(after.value)).toEqual({ kind: 'absent', recordId: written.value });
    const wiring = verifyWiring({ registry: liveWith(main), layout: { root: home } });
    expect(wiring.records(written.value, TASK)).toEqual({
      value: { verdict: 'fail', checkId: 'nope', taskId: null, origin: 'core', ...TREE },
    });
  });
});
