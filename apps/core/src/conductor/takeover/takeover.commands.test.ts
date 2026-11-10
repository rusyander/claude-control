import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { CREATED, deps, fakeClock, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { boardStopOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import type { CommandEnv } from '../commands/commands.types.ts';
import { pendingDeliveries } from '../human/deliver.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { seedSession } from '../model-tools/__fixtures__/seed.ts';
import type { ReworkPort, TakeoverPort } from './takeover.types.ts';

/**
 * Команды перехвата, возврата, доработки и остановки (этап 12, P157 P161 P162) через вход команд
 * ядра (`processCommand`) на настоящем журнале: порты — заглушки с журналом вызовов (чат и
 * носитель на настоящем пути — в интеграционных тестах проводки), свёртка, доставка слова
 * человека шагу (`human/ledger.ts` + `deliver.ts`) и машина задачи — настоящие.
 */

const strict = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});
/** Годно для `human`, мало для `human-strict`: пир не проверен, подписи нет. */
const loose = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'unknown',
  signature: 'absent',
});

function cmd(taskId: string, kind: CommandKind, fields: CommandEnvelope['fields'] = {}) {
  return { cmdId: newId(), kind, target: { taskId }, fields, proof: {} } as CommandEnvelope;
}

interface Calls {
  log: string[];
  ticks: number;
}

function ports(task: () => LiveTask, over: Partial<TakeoverPort> = {}, rework?: ReworkPort) {
  const calls: Calls = { log: [], ticks: 0 };
  const chatTaskId = newId();
  const takeover: TakeoverPort = {
    async open(t, cmdId) {
      calls.log.push(`open:${cmdId}`);
      const unitId = Object.keys(t.state.units)[0]!;
      return { ok: true, unitId, copy: '/copies/u0', chatTaskId };
    },
    async close(t, cmdId) {
      // Возврат кончает чат ПЕРВЫМ: строки возврата в журнале ещё нет.
      const handed = readJournalLines(t.dir, t.taskId).lines.some(
        (l) => l.kind === 'task.handback',
      );
      calls.log.push(`close:${cmdId}:${handed ? 'after' : 'before'}`);
      return { ok: true, ended: [chatTaskId] };
    },
    ...over,
  };
  const env: CommandEnv = {
    ...commandEnv(),
    board: () => ({ tick: () => void (calls.ticks += 1) }),
    takeover: () => takeover,
    ...(rework ? { rework: () => rework } : {}),
  };
  void task;
  return { env, calls, chatTaskId };
}

async function running() {
  const { task, taskId } = await openFresh(undefined, deps({ clock: fakeClock() }));
  task.append({ kind: 'task.created', actor: 'core', data: CREATED });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  const s = seedSession(task, { stepKind: 'work' });
  return { task, taskId, ...s };
}

const kinds = (t: LiveTask) => readJournalLines(t.dir, t.taskId).lines.map((l) => l.kind);

describe('take-over (P161)', () => {
  it('opens the chat through the port, journals task.takeover then a SOFT pause, frees the slot (board tick)', async () => {
    const { task, taskId, unitId } = await running();
    const { env, calls, chatTaskId } = ports(() => task);
    const c = cmd(taskId, 'take-over');
    const out = await processCommand(task, c, strict, env);
    expect(out).toMatchObject({
      status: 'applied',
      outcome: { from: 'running', to: 'paused', unitId, copy: '/copies/u0', chatTaskId },
    });
    expect(calls.log).toEqual([`open:${c.cmdId}`]);
    expect(task.state.takeover).toMatchObject({ unitId, copy: '/copies/u0', chatTaskId });
    expect(task.state.task).toBe('paused');
    // Мягкая пауза: сеанс шага снимается в безопасной точке, не деревом.
    expect(task.state.pause).toMatchObject({ now: false });
    const k = kinds(task);
    expect(k.indexOf('task.takeover')).toBeLessThan(k.lastIndexOf('task.transition'));
    expect(calls.ticks).toBe(1);
  });

  it('needs a strict proof: an unknown peer without a device signature is refused, pause with the same proof passes', async () => {
    const { task, taskId } = await running();
    const { env, calls } = ports(() => task);
    const out = await processCommand(task, cmd(taskId, 'take-over'), loose, env);
    expect(out).toMatchObject({ status: 'rejected', code: 'signature-required' });
    expect(calls.log).toEqual([]);
    expect(task.state.takeover).toBeUndefined();
    const paused = await processCommand(task, cmd(taskId, 'pause'), loose, env);
    expect(paused.status).toBe('applied');
  });

  it('refused in a draft, twice over an open takeover, and when the port refuses — no pause, no takeover line', async () => {
    const { task, taskId } = await openFresh(undefined, deps({ clock: fakeClock() }));
    task.append({ kind: 'task.created', actor: 'core', data: CREATED });
    const draft = ports(() => task);
    expect(await processCommand(task, cmd(taskId, 'take-over'), strict, draft.env)).toMatchObject({
      status: 'rejected',
      code: 'state-conflict',
    });
    expect(draft.calls.log).toEqual([]);

    const r = await running();
    const refusing = ports(() => r.task, {
      open: async () => ({ ok: false, code: 'no-copy', reason: 'no unit has a live copy' }),
    });
    expect(
      await processCommand(r.task, cmd(r.taskId, 'take-over'), strict, refusing.env),
    ).toMatchObject({ status: 'rejected', code: 'no-copy' });
    expect(r.task.state.task).toBe('running');
    expect(kinds(r.task)).not.toContain('task.takeover');

    const ok = ports(() => r.task);
    await processCommand(r.task, cmd(r.taskId, 'take-over'), strict, ok.env);
    expect(await processCommand(r.task, cmd(r.taskId, 'take-over'), strict, ok.env)).toMatchObject({
      status: 'rejected',
      code: 'state-conflict',
    });
  });

  it('no takeover port → takeover-unwired, the task keeps running', async () => {
    const { task, taskId } = await running();
    const out = await processCommand(task, cmd(taskId, 'take-over'), strict, commandEnv());
    expect(out).toMatchObject({ status: 'rejected', code: 'takeover-unwired' });
    expect(task.state.task).toBe('running');
  });
});

describe('hand-back (P161)', () => {
  it('resume is refused while the takeover is open; hand-back ends the chat FIRST, resumes, ticks the board and delivers the note to the interrupted step', async () => {
    const { task, taskId, stepId } = await running();
    const { env, calls } = ports(() => task);
    await processCommand(task, cmd(taskId, 'take-over'), strict, env);
    const resumed = await processCommand(task, cmd(taskId, 'resume'), strict, env);
    expect(resumed).toMatchObject({ status: 'rejected', code: 'state-conflict' });
    expect(task.state.task).toBe('paused');

    const back = cmd(taskId, 'hand-back', { note: 'renamed the helper, tests green' });
    const out = await processCommand(task, back, strict, env);
    expect(out).toMatchObject({ status: 'applied', outcome: { to: 'running', stepId } });
    expect(calls.log.at(-1)).toBe(`close:${back.cmdId}:before`);
    expect(task.state.takeover).toBeNull();
    expect(task.state.handback).toMatchObject({ note: 'renamed the helper, tests green' });
    expect(task.state.task).toBe('running');
    expect(calls.ticks).toBe(2);
    const pending = pendingDeliveries(readHumanLedger(task), stepId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toContain('renamed the helper, tests green');
    expect(pending[0]!.ref).toEqual({ kind: 'message', id: back.cmdId });
  });

  it('hand-back without a note: no message; without a takeover: refused; a chat that will not stop: refused and still paused', async () => {
    const { task, taskId, stepId } = await running();
    const { env } = ports(() => task);
    expect(await processCommand(task, cmd(taskId, 'hand-back'), strict, env)).toMatchObject({
      status: 'rejected',
      code: 'state-conflict',
    });
    await processCommand(task, cmd(taskId, 'take-over'), strict, env);
    const stuck = ports(() => task, {
      close: async () => ({ ok: false, code: 'chat-still-running', reason: 'session live' }),
    });
    expect(await processCommand(task, cmd(taskId, 'hand-back'), strict, stuck.env)).toMatchObject({
      status: 'rejected',
      code: 'chat-still-running',
    });
    expect(task.state.task).toBe('paused');
    expect(task.state.takeover).not.toBeNull();
    const out = await processCommand(task, cmd(taskId, 'hand-back'), strict, env);
    expect(out.status).toBe('applied');
    expect(out.outcome).not.toHaveProperty('stepId');
    expect(pendingDeliveries(readHumanLedger(task), stepId)).toEqual([]);
  });
});

describe('rework (P162)', () => {
  it('running → one message to the live step, delivered once', async () => {
    const { task, taskId, stepId } = await running();
    const c = cmd(taskId, 'rework', { text: 'also cover the empty list' });
    const out = await processCommand(task, c, strict, commandEnv());
    expect(out).toMatchObject({ status: 'applied', outcome: { stepId } });
    const pending = pendingDeliveries(readHumanLedger(task), stepId);
    expect(pending.map((p) => p.text)).toEqual([
      expect.stringContaining('also cover the empty list'),
    ]);
    // Повтор того же `cmdId` — сохранённый исход, второго сообщения нет.
    await processCommand(task, c, strict, commandEnv());
    expect(pendingDeliveries(readHumanLedger(task), stepId)).toHaveLength(1);
  });

  it('done with an open MR → the port opens a carrier keyed by the rework cmdId; done without MR and paused → refused naming the states', async () => {
    const { task, taskId, unitId } = await running();
    const asked: { cmdId: string; note: string }[] = [];
    const rework: ReworkPort = {
      async carrier(_source, cmdId, note) {
        asked.push({ cmdId, note });
        return { ok: true, carrierTaskId: 'carrier-1' };
      },
    };
    const env: CommandEnv = { ...commandEnv(), rework: () => rework };
    // Пауза — не то состояние.
    await processCommand(task, cmd(taskId, 'pause'), strict, env);
    const paused = await processCommand(task, cmd(taskId, 'rework', { text: 'x' }), strict, env);
    expect(paused).toMatchObject({ status: 'rejected', code: 'state-conflict' });
    expect(paused.reason).toContain('running, or done with an open MR');
    await processCommand(task, cmd(taskId, 'resume'), strict, env);
    task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    const noMr = await processCommand(task, cmd(taskId, 'rework', { text: 'x' }), strict, env);
    expect(noMr).toMatchObject({ status: 'rejected', code: 'state-conflict' });
    expect(noMr.reason).toContain('without an open MR');
    task.append({
      kind: 'publish.mr',
      actor: 'core',
      unitId,
      data: {
        unitId,
        forge: 'gitlab',
        mrId: '1',
        mrIid: 7,
        url: 'https://forge.example.com/g/p/-/merge_requests/7',
        sourceBranch: 'agentdeck/x',
        actionId: newId(),
      },
    });
    const c = cmd(taskId, 'rework', { text: 'rename it' });
    const out = await processCommand(task, c, strict, env);
    expect(out).toMatchObject({ status: 'applied', outcome: { carrierTaskId: 'carrier-1' } });
    expect(asked).toEqual([{ cmdId: c.cmdId, note: 'rename it' }]);
  });
});

describe('set-stop (P157)', () => {
  it('journals task.stop (the latest wins) and is refused after the first publish.mr', async () => {
    const { task, taskId, unitId } = await running();
    const env = commandEnv();
    expect(
      await processCommand(task, cmd(taskId, 'set-stop', { stop: 'end' }), strict, env),
    ).toMatchObject({ status: 'applied', outcome: { stop: 'end', from: 'none' } });
    await processCommand(task, cmd(taskId, 'set-stop', { stop: 'plan' }), strict, env);
    expect(boardStopOf(task.state)).toBe('plan');
    task.append({
      kind: 'publish.mr',
      actor: 'core',
      unitId,
      data: {
        unitId,
        forge: 'gitlab',
        mrId: '1',
        mrIid: 3,
        url: 'https://forge.example.com/g/p/-/merge_requests/3',
        sourceBranch: 'agentdeck/x',
        actionId: newId(),
      },
    });
    const late = await processCommand(task, cmd(taskId, 'set-stop', { stop: 'mr' }), strict, env);
    expect(late).toMatchObject({ status: 'rejected', code: 'state-conflict' });
    expect(boardStopOf(task.state)).toBe('plan');
  });
});
