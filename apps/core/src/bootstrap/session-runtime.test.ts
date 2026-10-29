import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapters/index.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { createSessionRuntime } from './session-runtime.ts';

/**
 * Ход, начатый самим CLI (03, P48), виден только по журналу: рантайм пишет строку
 * `turn.cli-initiated` на каждое такое событие переходника. Сессия прежнего ядра, прикреплённая
 * заново, начинает поток с истории — строка пишется только сверх уже записанных (k-е ↔ k-я).
 */

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

function fakeAdapter(events: AdapterEvent[]): CliAdapter {
  return {
    id: 'fake',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

async function taskWithSession(): Promise<{ task: LiveTask; sessionId: string }> {
  const registry = createTaskRegistry(tempDir('rt-cli-turn-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  return { task, sessionId };
}

const cliTurns = (task: LiveTask, sessionId: string) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'turn.cli-initiated' && l.sessionId === sessionId)
    .map((l) => ({ actor: l.actor, data: l.data }));

const wake = (cause: 'background-wake' | 'notification' | 'late-tail'): AdapterEvent => ({
  type: 'turn.cli-initiated',
  cause,
  numTurns: 1,
});

async function run(
  task: LiveTask,
  sessionId: string,
  events: AdapterEvent[],
  resumed: boolean,
  replayed?: number,
) {
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const seen: string[] = [];
  const attached = createSessionRuntime().attach({
    task,
    binding: got.binding,
    adapter: fakeAdapter(events),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    resumed,
    ...(replayed === undefined ? {} : { replayed }),
    onEvent: (e) => seen.push(e.type),
  });
  await attached.done;
  return seen;
}

describe('session runtime journals turns the CLI started itself', () => {
  it('each turn.cli-initiated event becomes one journal line with its cause, by the adapter', async () => {
    const { task, sessionId } = await taskWithSession();
    const seen = await run(
      task,
      sessionId,
      [
        { type: 'text.delta', text: 'x' } as AdapterEvent,
        wake('background-wake'),
        wake('late-tail'),
      ],
      false,
    );
    expect(seen).toEqual(['text.delta', 'turn.cli-initiated', 'turn.cli-initiated']);
    expect(cliTurns(task, sessionId)).toEqual([
      { actor: 'adapter:fake', data: { sessionId, cause: 'background-wake' } },
      { actor: 'adapter:fake', data: { sessionId, cause: 'late-tail' } },
    ]);
  });

  it('a re-attached session replays its history: journaled turns are not written twice, a new one is', async () => {
    const { task, sessionId } = await taskWithSession();
    await run(task, sessionId, [wake('background-wake')], false);
    // Новое ядро: история (тот же ход) и затем новый ход CLI.
    await run(task, sessionId, [wake('background-wake'), wake('notification')], true);
    expect(cliTurns(task, sessionId).map((t) => (t.data as { cause: string }).cause)).toEqual([
      'background-wake',
      'notification',
    ]);
  });

  // core-s2 F-105: журнал знает больше ходов, чем вернула история (строка потеряна, oversize) —
  // новый ход после истории всё равно пишется, счёт не съедает его.
  it('F-105 a turn after the replayed history is journaled even when the journal already counts more turns than the history holds', async () => {
    const { task, sessionId } = await taskWithSession();
    await run(task, sessionId, [wake('background-wake'), wake('late-tail')], false);
    await run(task, sessionId, [wake('background-wake'), wake('notification')], true, 1);
    expect(cliTurns(task, sessionId).map((t) => (t.data as { cause: string }).cause)).toEqual([
      'background-wake',
      'late-tail',
      'notification',
    ]);
  });

  it('a lost lease does not break the stream: the event still reaches the subscriber', async () => {
    const { task, sessionId } = await taskWithSession();
    const notes: string[] = [];
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    const closed = {
      ...task,
      append: () => {
        throw new Error('lease lost');
      },
    } as LiveTask;
    const seen: string[] = [];
    await createSessionRuntime({ note: (event) => notes.push(event) }).attach({
      task: closed,
      binding: got.binding,
      adapter: fakeAdapter([wake('notification')]),
      handle: { sessionId } as SessionHandle,
      context: CONTEXT,
      onEvent: (e) => seen.push(e.type),
    }).done;
    expect(seen).toEqual(['turn.cli-initiated']);
    expect(notes).toEqual(['turn.cli-initiated.unjournaled']);
  });
});
