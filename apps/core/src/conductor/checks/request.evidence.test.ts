import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_DEADLINE_MS } from '../../verifier/run/deadline.ts';
import type { RecordDraft } from '../../verifier/store/index.ts';
import {
  checkEntry,
  checkRegistry,
  makeHarness,
  TASK,
  type Harness,
} from './__fixtures__/harness.ts';
import { modelCheck, type ModelCheckContext } from './model-tool.ts';

/**
 * Доказательства единого входа (ревью стадии 3, волна 2): бюджет ответа в ожидании слота, причина
 * несостоявшегося запуска у модели, выученный срок по проверке и единице поверх ключей, свой номер
 * прогона у вывода `pass-flaky`, потерянная строка журнала названа, путь вывода записи в ответе
 * модели. Стенд — настоящие очередь, хранилище, судья и дочерний процесс.
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

const ofKind = <K extends string>(h: Harness, kind: K) =>
  h.journal.filter((j) => j.kind === kind).map((j) => j.data as Record<string, unknown>);

function redraft(rec: CheckRecord, over: Partial<RecordDraft>): RecordDraft {
  const { v: _v, id: _id, log: _log, sig: _sig, ...draft } = rec;
  return { ...draft, ...over };
}

describe('conductor/checks requestCheck evidence', () => {
  it('a slot that never frees is waited only within the answer budget: defer(slot), ticket withdrawn, claim released, nothing spawned', async () => {
    const h = await harness({ slots: 1, answerBudgetMs: 400 });
    h.mode('pass');
    const blocker = h.queue.enqueue({
      class: 'deliver',
      project: 'other',
      taskId: TASK,
      key: null,
    });
    const got = await h.queue.acquire(blocker.ticketId);
    if (!('granted' in got)) throw new Error(`blocker not granted: ${JSON.stringify(got)}`);
    const keep = setInterval(() => h.queue.heartbeat(got.granted.leaseId), 50);
    const pending = h.service.requestCheck(h.req());
    try {
      const answer = await Promise.race([pending, sleep(4_000).then(() => 'hung' as const)]);
      expect(answer).toMatchObject({ kind: 'defer', until: 'slot' });
      if (typeof answer === 'object' && answer.kind === 'defer')
        expect(answer.reason).toMatch(/answer budget/);
      const view = h.queue.view();
      expect('value' in view && view.value.tickets.map((t) => t.ticket.project)).toEqual([]);
      const held = h.queue.inflight('p', h.keyFor('tests', 'app'));
      expect(held).toEqual({ value: null });
      const requested = ofKind(h, 'check.requested')[0]?.['checkRunId'];
      const moves = ofKind(h, 'check.transition').filter((d) => d['checkRunId'] === requested);
      expect(moves.map((d) => `${String(d['from'])}>${String(d['to'])}`)).toEqual([
        'queued>aborted',
      ]);
      expect(h.spawns()).toEqual([]);
    } finally {
      clearInterval(keep);
      h.queue.release(got.granted.leaseId);
      await pending;
    }
  });

  it('a check that could not start tells the model why: the spawn failure is in the reply, not a bare env', async () => {
    const reg = checkRegistry();
    const missing = checkEntry({ argv: ['adk-no-such-tool-7f3', '{units}'], filter: undefined });
    const h = await harness({
      registry: { value: { ...reg, checks: [missing, ...reg.checks.slice(1)] } },
    });
    const reply = await modelCheck(h.service, { checkId: 'tests' }, ctx(h), 30_000);
    expect(reply.verdict).toBe('no-verdict');
    expect(reply.reason).toMatch(/^env: .*adk-no-such-tool-7f3/);
  });

  it('the run deadline is learned per check and unit across keys, and an aborted run raises it to twice its length', async () => {
    const h = await harness();
    h.mode('pass');
    const first = await h.service.requestCheck(h.req());
    expect(first).toMatchObject({ kind: 'ran', verdict: { kind: 'pass' } });
    if (first.kind !== 'ran' || first.recordId === null) return;
    const caller = h.req({ road: 'capture-wrapper', origin: 'session', exec: 'caller' });
    h.edit({ 'apps/app/main.ts': { blob: 'e'.repeat(40) } });
    const learned = await h.service.requestCheck(caller);
    expect(learned).toMatchObject({ kind: 'leased', deadlineMs: MIN_DEADLINE_MS });
    if (learned.kind !== 'leased') return;
    await h.service.completeCheck(learned.checkRunId, { exit: 0, ms: 5, log: 'ok\n' });
    // Прогон на прежнем ключе снят на 40-й минуте: следующий срок не меньше 80 минут.
    const rec = h.store.record(first.recordId);
    if (!('value' in rec)) throw new Error('record unreadable');
    const aborted = h.store.write(
      redraft(rec.value, {
        verdict: { kind: 'no-verdict', reason: 'aborted' },
        exit: null,
        ms: 40 * 60_000,
        startedAt: Date.now(),
      }),
      '',
    );
    expect('value' in aborted).toBe(true);
    h.edit({ 'apps/app/main.ts': { blob: 'd'.repeat(40) } });
    const raised = await h.service.requestCheck(caller);
    expect(raised).toMatchObject({ kind: 'leased', deadlineMs: 80 * 60_000 });
    if (raised.kind === 'leased')
      await h.service.completeCheck(raised.checkRunId, { exit: 0, ms: 5, log: 'ok\n' });
  });

  it('a pass-flaky conclusion is its own run: own checkRunId linked to the red run, its own recorded line, one record per run id', async () => {
    const h = await harness();
    h.mode('flaky');
    const answer = await h.service.requestCheck(h.req());
    expect(answer).toMatchObject({ kind: 'ran', verdict: { kind: 'pass-flaky' } });
    if (answer.kind !== 'ran') return;
    const requested = ofKind(h, 'check.requested');
    const red = requested[0]?.['checkRunId'];
    expect(requested.map((d) => [d['grade'], d['retryOf'] ?? null])).toEqual([
      ['unit', null],
      ['retry', red],
      ['unit', red],
    ]);
    expect(answer.checkRunId).toBe(requested[2]?.['checkRunId']);
    expect(answer.checkRunId).not.toBe(red);
    const recorded = ofKind(h, 'check.recorded');
    expect(recorded).toContainEqual({ checkRunId: answer.checkRunId, recordId: answer.recordId });
    const runIds = recorded.map((d) => d['checkRunId']);
    expect(new Set(runIds).size).toBe(runIds.length);
    const moves = ofKind(h, 'check.transition')
      .filter((d) => d['checkRunId'] === answer.checkRunId)
      .map((d) => `${String(d['from'])}>${String(d['to'])}`);
    expect(moves).toEqual(['queued>leased', 'leased>running', 'running>recorded']);
    expect(h.badLines).toEqual([]);
  });

  it('a journal line the task journal refuses is named in the answer and on the loss channel, never dropped silently', async () => {
    const h = await harness({
      journalRefuses: (e) => (e.kind === 'check.recorded' ? 'schema: recordId' : null),
    });
    h.mode('pass');
    const reply = await modelCheck(h.service, { checkId: 'tests' }, ctx(h), 30_000);
    expect(reply.verdict).toBe('pass');
    expect(reply.reason).toMatch(/journal lost check\.recorded: .*schema: recordId/);
    expect(h.losses).toEqual([expect.stringMatching(/^check\.recorded: .*schema: recordId/)]);
  });

  it('the model reply carries the log path of its record; the file there is the run output', async () => {
    const h = await harness();
    h.mode('fail');
    const reply = await modelCheck(h.service, { checkId: 'tests' }, ctx(h), 30_000);
    expect(reply.verdict).toBe('fail');
    expect(reply.recordId).not.toBeNull();
    expect(reply.logPath).toBe(h.store.logPath(reply.recordId as string));
    expect(reply.units[0]?.logPath).toBe(reply.logPath);
    const log = gunzipSync(readFileSync(reply.logPath as string)).toString('utf8');
    expect(log).toContain('Tests  1 failed (1)');
  });

  it('a run whose output the runner cut to head and tail is recorded as truncated, not as a whole log', async () => {
    const h = await harness();
    h.mode('loud');
    const reply = await modelCheck(h.service, { checkId: 'tests' }, ctx(h), 60_000);
    expect(reply.verdict).toBe('fail');
    const rec = h.store.record(reply.recordId as string);
    expect('value' in rec && rec.value.log.truncated).toBe(true);
  });
});
