import { join } from 'node:path';
import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import type { TaskEvent, TaskState } from '@agentdeck/contracts/core/states';
import { afterEach, describe, expect, it } from 'vitest';
import { processCommand } from '../conductor/commands.ts';
import { commandEnv } from '../conductor/commands/__fixtures__/command-env.ts';
import type { CommandEnv } from '../conductor/commands/commands.types.ts';
import { estimateTask, inPlaceRootOf } from '../conductor/estimate/index.ts';
import { estimateBody } from '../conductor/split/__fixtures__/split-stand.ts';
import { takeoverChatsOf } from '../conductor/takeover/chat.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { longForm } from '../platform/paths.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import { decidePermit } from '../policy/permit/permit.ts';
import {
  closeWorlds,
  copyFor,
  linesOf,
  world,
  type World,
} from './forge-wiring/__fixtures__/answer-world.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from './guard-wiring/__fixtures__/guard-stand.ts';
import { createTakeoverWiring, type TakeoverWiring } from './takeover-wiring.ts';

/**
 * Перехват и возврат на настоящем пути (этап 12, P161): настоящий git (основной репозиторий и
 * копия единицы — рабочее дерево на её ветке), настоящая оценка чата `chat@1` на месте в копии,
 * настоящий реестр, вход команд ядра и проводка `createTakeoverWiring`. Сеансов модели нет —
 * чат кончается до того, как исполнитель начал бы его (ждать снятия нечего).
 */

afterEach(closeWorlds);

const strict = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

function cmd(taskId: string, kind: CommandKind, fields: CommandEnvelope['fields'] = {}) {
  return { cmdId: newId(), kind, target: { taskId }, fields, proof: {} } as CommandEnvelope;
}

function wiringOf(w: World, ticks: { n: number }): TakeoverWiring {
  return createTakeoverWiring({
    registry: w.registry,
    layout: w.layout,
    note: (event, data) => w.notes.push({ event, data }),
    split: () => w.env,
    config: {} as never,
    board: () => ({ tick: () => void (ticks.n += 1) }),
    now: Date.now,
    git: w.git,
    chatWaitMs: 0,
  });
}

/** Идущая задача с копией единицы 0 на её ветке — так её выкладывает дирижёр. */
async function runningWithCopy(
  w: World,
): Promise<{ task: LiveTask; unitId: string; copy: string }> {
  const est = await estimateTask(
    estimateBody([w.st.main], { title: 'Manual task' }),
    w.registry,
    w.env,
  );
  if (est.status !== 202) throw new Error(JSON.stringify(est));
  const task = w.registry.live(est.reply.taskId)!;
  const [unitId, unit] = Object.entries(task.state.units)[0]!;
  const copy = join(w.st.root, `copy-${unitId.slice(-6)}`);
  w.st.g(w.st.main, 'worktree', 'add', '-q', '-b', unit.branch, copy, 'origin/main');
  copyFor(w, task, unitId, copy);
  const moves: [TaskEvent, TaskState, TaskState][] = [
    ['estimated', 'estimating', 'awaiting-launch'],
    ['launch', 'awaiting-launch', 'running'],
  ];
  for (const [event, from, to] of moves) {
    if (task.state.task !== from) continue;
    task.append({
      kind: 'task.transition',
      actor: 'core',
      data: { taskId: task.taskId, event, from, to },
    });
  }
  if (task.state.task !== 'running') throw new Error(`task is ${task.state.task}`);
  return { task, unitId, copy };
}

function envOf(wiring: TakeoverWiring, ticks: { n: number }): CommandEnv {
  return {
    ...commandEnv(),
    takeover: () => wiring.takeover(),
    board: () => ({ tick: () => void (ticks.n += 1) }),
  };
}

describe('takeover wiring on the real path (P161)', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('take-over opens ONE chat@1 in place in the unit copy with an edit grant on that copy only; hand-back ends it first and resumes', async () => {
    const w = await world();
    const ticks = { n: 0 };
    const wiring = wiringOf(w, ticks);
    const env = envOf(wiring, ticks);
    const { task, unitId, copy } = await runningWithCopy(w);

    const take = cmd(task.taskId, 'take-over');
    const out = await processCommand(task, take, strict, env);
    if (out.status !== 'applied') throw new Error(JSON.stringify(out));
    const chatTaskId = (out.outcome as { chatTaskId: string }).chatTaskId;
    expect(task.state.task).toBe('paused');
    expect(task.state.takeover).toMatchObject({ unitId, copy, chatTaskId });
    expect(ticks.n).toBe(1);

    const chat = w.registry.live(chatTaskId)!;
    const created = chat.state.created!;
    expect(created.scenario.id).toBe('chat');
    expect(created.placement).toBe('in-place');
    expect(created.launchPolicy).toBe('auto');
    expect(created.takeoverOf).toEqual({ taskId: task.taskId, unitId });
    // Ключ оценки чата — `cmdId` перехвата: повтор после краха находит этот же чат.
    expect(created.origin).toEqual({ cmdId: take.cmdId });
    expect(linesOf(chat, 'grant.given')).toEqual([
      { cmdId: take.cmdId, project: copy, globs: ['**'], ops: ['edit'] },
    ]);
    // Сеанс чата идёт в копии единицы: корень — копия, правка вне неё отказана судьёй права.
    const root = inPlaceRootOf(chat, newId());
    expect(root && longForm(root)).toBe(longForm(copy));
    const ctx = {
      copyRoot: longForm(copy),
      ownedPaths: [],
      deny: { mcpTools: [], argvPrefixes: [] },
      platformPaths: [],
      endpointSources: [],
      grantRequired: [],
      grants: [],
    } as unknown as Parameters<typeof decidePermit>[1];
    expect(decidePermit({ action: 'edit', target: join(copy, 'a.txt') } as never, ctx).allow).toBe(
      true,
    );
    expect(
      decidePermit({ action: 'edit', target: join(w.st.main, 'a.txt') } as never, ctx),
    ).toMatchObject({
      allow: false,
      code: 'outside-copy',
    });

    // Тот же `cmdId` у порта (крах между чатом и строкой перехвата) — тот же чат.
    const again = await wiring.takeover()!.open(task, take.cmdId);
    expect(again).toMatchObject({ ok: true, chatTaskId });
    expect(takeoverChatsOf(w.registry, task.taskId)).toEqual([chatTaskId]);

    const back = cmd(task.taskId, 'hand-back', { note: 'fixed by hand' });
    const done = await processCommand(task, back, strict, env);
    expect(done).toMatchObject({
      status: 'applied',
      outcome: { to: 'running', ended: [chatTaskId] },
    });
    // Чат кончился ДО строки возврата: его грант на копию не пережил перехват.
    expect(chat.state.ended).toBe('done');
    const chatEnd = linesOf(chat, 'task.ended');
    expect(chatEnd).toHaveLength(1);
    expect(takeoverChatsOf(w.registry, task.taskId)).toEqual([]);
    expect(task.state.takeover).toBeNull();
    expect(task.state.task).toBe('running');
    expect(ticks.n).toBe(2);
  });

  it('start() sweeps an orphan takeover chat whose source ended with the takeover still open', async () => {
    const w = await world();
    const ticks = { n: 0 };
    const wiring = wiringOf(w, ticks);
    const { task } = await runningWithCopy(w);
    const out = await processCommand(
      task,
      cmd(task.taskId, 'take-over'),
      strict,
      envOf(wiring, ticks),
    );
    const chatTaskId = (out.outcome as { chatTaskId: string }).chatTaskId;
    // Источник отменён, пока перехват открыт: чат — сирота.
    await processCommand(task, cmd(task.taskId, 'cancel'), strict, commandEnv());
    expect(task.state.ended).toBe('cancelled');
    expect(w.registry.live(chatTaskId)!.state.ended).toBeNull();
    wiring.start();
    await wiring.stop();
    expect(w.registry.live(chatTaskId)!.state.ended).toBe('done');
    expect(w.notes.map((n) => n.event)).toContain('takeover.orphans');
  });

  it('a take-over retried after a crash whose chat the orphan sweep already ended is refused, the task stays untaken', async () => {
    const w = await world();
    const ticks = { n: 0 };
    const wiring = wiringOf(w, ticks);
    const { task } = await runningWithCopy(w);
    const take = cmd(task.taskId, 'take-over');
    // Крах между чатом и строкой перехвата: чат открыт портом, строки `task.takeover` нет.
    const opened = await wiring.takeover()!.open(task, take.cmdId);
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    // Загрузка после краха: обход сирот кончает чат — перехвата у источника нет.
    wiring.start();
    await wiring.stop();
    expect(w.registry.live(opened.chatTaskId)!.state.ended).toBe('done');
    // Повтор того же `cmdId`: мёртвый чат перехвату не отдаётся.
    const out = await processCommand(task, take, strict, envOf(wiring, ticks));
    expect(out).toMatchObject({ status: 'rejected', code: 'takeover-chat-ended' });
    expect(task.state.takeover ?? null).toBeNull();
    expect(task.state.task).toBe('running');
    expect(ticks.n).toBe(0);
  });

  it('a source cancelled AFTER start() loses its takeover chat on the next sweep, without a reboot', async () => {
    const w = await world();
    const ticks = { n: 0 };
    const wiring = createTakeoverWiring({
      registry: w.registry,
      layout: w.layout,
      note: (event, data) => w.notes.push({ event, data }),
      split: () => w.env,
      config: {} as never,
      board: () => ({ tick: () => void (ticks.n += 1) }),
      now: Date.now,
      git: w.git,
      chatWaitMs: 0,
      sweepEveryMs: 25,
    });
    wiring.start();
    try {
      const { task } = await runningWithCopy(w);
      const out = await processCommand(
        task,
        cmd(task.taskId, 'take-over'),
        strict,
        envOf(wiring, ticks),
      );
      const chatTaskId = (out.outcome as { chatTaskId: string }).chatTaskId;
      await processCommand(task, cmd(task.taskId, 'cancel'), strict, commandEnv());
      const chat = w.registry.live(chatTaskId)!;
      const until = Date.now() + 5_000;
      while (chat.state.ended === null && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(chat.state.ended).toBe('done');
    } finally {
      await wiring.stop();
    }
  });
});
