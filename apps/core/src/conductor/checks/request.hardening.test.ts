import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_TOOL_DESCRIPTIONS } from '@agentdeck/contracts/core/model-tools';
import type { CheckRecord, CheckRegistry } from '@agentdeck/contracts/core/records';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { compose } from '../../verifier/compose/compose.ts';
import {
  checkEntry,
  checkRegistry,
  makeHarness,
  TASK,
  type Harness,
} from './__fixtures__/harness.ts';
import { preRunCandidates } from './idle.ts';
import { modelCheck, type ModelCheckContext } from './model-tool.ts';

/**
 * Единый вход проверки на краях (ревью стадии 3): чужой argv модели, разряд записи посреди
 * работы, сбои записи очереди и хранилища, имя теста-флаг. Стенд тот же — настоящие очередь,
 * хранилище, судья и дочерний процесс; подменён только отдельный метод очереди или хранилища там,
 * где нужен сбой диска (ENOSPC/EPERM/EISDIR), которого на тестовой машине не вызвать.
 */

const open: Harness[] = [];
async function harness(options?: Parameters<typeof makeHarness>[0]): Promise<Harness> {
  const h = await makeHarness(options);
  open.push(h);
  return h;
}
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const diskError = (message: string): Error =>
  Object.assign(new Error(message), { code: message.split(':')[0] });

function ctx(h: Harness, over: Partial<ModelCheckContext> = {}): ModelCheckContext {
  return {
    taskId: TASK,
    stepId: '0192f000-0000-7000-8000-0000000000bb',
    project: 'p',
    copyDir: h.req().copyDir,
    class: 'work',
    phase: 'final',
    registryUnits: ['app', 'admin', 'shared'],
    changedUnits: ['app'],
    packageChecks: ['tests', 'lint'],
    ...over,
  };
}

const decisions = (h: Harness): number => h.journal.filter((j) => j.kind === 'decision').length;

describe('conductor/checks requestCheck hardening', () => {
  it('model argv outside the registry is refused by name: nothing spawns, nothing is written', async () => {
    const h = await harness();
    const marker = join(h.dir, 'pwned.txt');
    const argv = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
    ];
    const reply = await modelCheck(h.service, { argv }, ctx(h, { phase: 'mid-task' }), 30_000);
    expect(reply.verdict).toBe('refused');
    expect(reply.reason).toMatch(/not-registered/);
    expect(existsSync(marker)).toBe(false);
    expect(h.spawns()).toEqual([]);
    // Дорога захвата с тем же argv по-прежнему выдаёт его вызывающему: исполняет сессия под своими правами.
    const leased = await h.service.requestCheck(
      h.req({
        road: 'capture-wrapper',
        origin: 'session',
        exec: 'caller',
        checkId: undefined,
        argv,
        unit: '',
      }),
    );
    expect(leased.kind).toBe('leased');
    if (leased.kind === 'leased')
      await h.service.completeCheck(leased.checkRunId, { exit: 0, ms: 1, log: '' });
  });

  it('the check tool description the model reads states the registry rule and names the refusal the core gives', async () => {
    const text = MODEL_TOOL_DESCRIPTIONS.check;
    expect(text).toMatch(/argv that matches a registry check/);
    const h = await harness();
    const answer = await h.service.requestCheck(
      h.req({ road: 'model-tool', checkId: undefined, argv: ['node', '-v'], unit: '' }),
    );
    expect(answer.kind).toBe('refuse');
    if (answer.kind !== 'refuse') return;
    // Описание называет тот же код, что видит модель в отказе.
    expect(text).toContain(answer.unmet[0]?.code ?? '<none>');
  });

  it('mid-task run of a whole unit is graded unit: the final compose on the same tree is ready with no run', async () => {
    const h = await harness();
    h.mode('pass');
    const mid = await h.service.requestCheck(h.req({ phase: 'mid-task', changedUnits: ['app'] }));
    expect(mid).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    if (mid.kind !== 'ran' || mid.recordId === null) throw new Error('no record');
    const rec = h.store.record(mid.recordId);
    if (!('value' in rec)) throw new Error('record unreadable');
    expect(rec.value.grade).toBe('unit');
    const reg: CheckRegistry = {
      ...checkRegistry(),
      checks: checkRegistry().checks.filter((c) => c.id === 'tests'),
    };
    const key = h.keyFor('tests', 'app');
    const records: Record<string, CheckRecord[]> = { [key]: [rec.value] };
    const decision = compose({
      repo: 'p',
      tree: '0'.repeat(64),
      base: 'main',
      registry: reg,
      changed: ['apps/app/main.ts'],
      records,
      quarantine: [],
      coverage: 'warn',
      compositionId: newId(),
      keys: [{ checkId: 'tests', unit: 'app', key: { value: key }, baseKey: null }],
      covered: { value: ['apps/app/main.ts'] },
      scenarioRequired: [],
      since: Date.now(),
    });
    expect(decision.kind).toBe('ready');
    expect(h.spawns()).toHaveLength(1);
  });

  it('a throwing heartbeat never reaches the process: the caller run and the core run both end with a record', async () => {
    const h = await harness();
    const boom = (): never => {
      throw diskError('EPERM: operation not permitted, rename lease.tmp -> lease.json');
    };
    h.queue.heartbeat = boom;
    h.queue.beatInflight = boom;
    const leased = await h.service.requestCheck(
      h.req({ road: 'capture-wrapper', origin: 'session', exec: 'caller' }),
    );
    expect(leased.kind).toBe('leased');
    if (leased.kind !== 'leased') return;
    await sleep(350);
    const done = await h.service.completeCheck(leased.checkRunId, { exit: 0, ms: 5, log: 'ok\n' });
    expect(done).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    h.mode('slow', 1_500);
    h.edit({ 'apps/app/main.ts': { blob: 'e'.repeat(40) } });
    const core = await h.service.requestCheck(h.req());
    expect(core).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
  });

  it('a throw between the in-flight claim and the lease releases the claim: the next request runs', async () => {
    const h = await harness({ answerBudgetMs: 500 });
    h.mode('pass');
    const enqueue = h.queue.enqueue.bind(h.queue);
    let failOnce = true;
    h.queue.enqueue = (t) => {
      if (failOnce) {
        failOnce = false;
        throw diskError('ENOSPC: no space left on device');
      }
      return enqueue(t);
    };
    const first = await h.service
      .requestCheck(h.req())
      .catch((error: Error) => ({ kind: 'rejected', message: error.message }));
    expect(first).toMatchObject({ kind: 'defer', until: 'slot' });
    expect((first as { reason: string }).reason).toMatch(/ENOSPC/);
    expect(h.queue.inflight('p', h.keyFor('tests', 'app'))).toEqual({ value: null });
    const second = await h.service.requestCheck(h.req());
    expect(second).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    expect(h.spawns()).toHaveLength(1);
  });

  it('an unreadable in-flight lock is waited out within the answer budget, not spun on', async () => {
    const h = await harness({ answerBudgetMs: 300 });
    h.mode('pass');
    let claims = 0;
    h.queue.inflight = () => ({ unknown: 'EISDIR: illegal operation on a directory, read' });
    // Две сотни отказов — потом захват удаётся: без паузы цикл сжёг бы их за миг и прогнал проверку.
    h.queue.claimInflight = async () => {
      claims += 1;
      return claims > 200
        ? { claimed: true }
        : { claimed: false, hold: null, reason: 'holder unreadable: EISDIR' };
    };
    const started = Date.now();
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'defer', until: 'slot' });
    expect((answer as { reason: string }).reason).toMatch(/EISDIR/);
    expect(claims).toBeLessThan(30);
    expect(decisions(h)).toBeLessThan(30);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(h.spawns()).toEqual([]);
  });

  it('a run the store refused to record is never told green; a refused pass-flaky leaves no quarantine', async () => {
    const h = await harness();
    h.mode('pass');
    h.store.write = () => ({ unknown: 'ENOSPC: no space left on device' });
    const reply = await modelCheck(h.service, { checkId: 'tests' }, ctx(h), 30_000);
    expect(reply.verdict).toBe('no-verdict');
    expect(reply.reason).toMatch(/ENOSPC/);
    const f = await harness();
    f.mode('flaky');
    const write = f.store.write.bind(f.store);
    f.store.write = (draft, log) =>
      draft.verdict.kind === 'pass-flaky'
        ? { unknown: 'ENOSPC: no space left on device' }
        : write(draft, log);
    const flaky = await modelCheck(f.service, { checkId: 'tests' }, ctx(f), 30_000);
    expect(flaky.verdict).toBe('no-verdict');
    expect(flaky.reason).toMatch(/ENOSPC/);
    expect(f.quarantine).toEqual([]);
  });

  it('a selection name that starts with a dash is refused before any spawn', async () => {
    const h = await harness();
    h.mode('pass');
    const answer = await h.service.requestCheck(h.req({ selection: ['--root=/elsewhere'] }));
    expect(answer).toMatchObject({ kind: 'refuse', unmet: [{ code: 'selection-unsafe' }] });
    const reply = await modelCheck(
      h.service,
      { checkId: 'tests', scope: ['app', '--manifest-path=../other/Cargo.toml'] },
      ctx(h),
      30_000,
    );
    expect(reply.verdict).toBe('refused');
    expect(h.spawns()).toEqual([]);
  });

  it('flaky retries keep the in-flight claim alive under the claim id, not the retry id', async () => {
    const h = await harness();
    // Повтор живёт 1,5 с: удары раннера начинаются после чтения личности дочернего процесса,
    // а на Windows оно само занимает сотни миллисекунд.
    h.mode('flaky', 1_500);
    const ids: string[] = [];
    const beat = h.queue.beatInflight.bind(h.queue);
    h.queue.beatInflight = (project, key, checkRunId) => {
      ids.push(checkRunId);
      return beat(project, key, checkRunId);
    };
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'pass-flaky' } });
    if (answer.kind !== 'ran') return;
    expect(ids.length).toBeGreaterThan(0);
    // Ключ взят номером первого (красного) прогона; вывод `pass-flaky` — свой номер (A1r4-F06).
    const claim = h.journal.find((j) => j.kind === 'check.requested')?.data as {
      checkRunId: string;
    };
    expect([...new Set(ids)]).toEqual([claim.checkRunId]);
  });

  it('idle pre-run picks checks required at publish or deliver, as the final compose does', () => {
    const reg = checkRegistry();
    const deliverOnly = {
      ...reg.checks[1],
      id: 'e2e',
      requiredAt: ['deliver'],
    } as (typeof reg.checks)[number];
    const asks = preRunCandidates(
      { ...reg, checks: [...reg.checks, deliverOnly] },
      { taskId: TASK, project: 'p', copyDir: 'c', finishedUnits: ['app'] },
    );
    expect(asks.map((a) => a.checkId)).toEqual(['tests', 'lint', 'e2e']);
  });

  it('B2-F02 a registry cwd outside the copy (.. or a junction out) spawns nothing: named no-verdict, record written; a cwd inside runs', async () => {
    // Реестр читается из рабочего дерева задачи: модель может вписать туда любой cwd.
    const reg: CheckRegistry = {
      ...checkRegistry(),
      checks: [
        checkEntry({ id: 'tests', cwd: '..' }),
        checkEntry({ id: 'lint', cwd: 'link', filter: undefined }),
        checkEntry({ id: 'whole', cwd: 'sub', filter: undefined }),
      ],
    };
    const h = await harness({ registry: { value: reg } });
    h.mode('pass');
    const copyDir = h.req().copyDir;
    const outside = join(h.dir, 'outside');
    mkdirSync(outside);
    mkdirSync(join(copyDir, 'sub'));
    symlinkSync(outside, join(copyDir, 'link'), 'junction');
    for (const checkId of ['tests', 'lint']) {
      const out = await h.service.requestCheck(h.req({ checkId }));
      expect(out).toMatchObject({
        kind: 'ran',
        verdict: { kind: 'no-verdict' },
        note: expect.stringMatching(/check cwd .*outside the copy/),
      });
      if (out.kind !== 'ran' || out.recordId === null) throw new Error('no record');
      const rec = h.store.record(out.recordId);
      expect('value' in rec && rec.value.verdict.kind).toBe('no-verdict');
    }
    expect(h.spawns()).toEqual([]);
    // Дорога захвата: argv вызывающему не выдаётся, аренда снята.
    const leased = await h.service.requestCheck(
      h.req({ road: 'capture-wrapper', origin: 'session', exec: 'caller', checkId: 'tests' }),
    );
    expect(leased).toMatchObject({ kind: 'ran', verdict: { kind: 'no-verdict' } });
    const inside = await h.service.requestCheck(h.req({ checkId: 'whole', unit: '' }));
    expect(inside).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    expect(h.spawns()).toHaveLength(1);
  });
});
