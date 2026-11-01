import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapters/index.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import type { ObserverTap } from './observer-wiring/observer-wiring.types.ts';
import { createSessionRuntime, type AttachSpec } from './session-runtime.ts';

/**
 * Кран наблюдателя (этап 8, волна 0): рантайм отдаёт ему каждое событие потока с меткой
 * `inHistory` — по тому же правилу `resumed`/`replayed`, что и запись ходов CLI: история
 * прикреплённой заново сессии уже в журнале, второй раз её факт не пишется. Сбой крана —
 * `observer.tap.failed`, поток идёт дальше.
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

const EVENTS = [
  { type: 'text.delta', text: 'a' },
  { type: 'text.delta', text: 'b' },
  { type: 'text.delta', text: 'c' },
] as AdapterEvent[];

function fakeAdapter(): CliAdapter {
  return {
    id: 'fake',
    events: async function* () {
      for (const event of EVENTS) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
  } as unknown as CliAdapter;
}

async function runWith(tap: ObserverTap, spec: Pick<AttachSpec, 'resumed' | 'replayed'>) {
  const registry = createTaskRegistry(tempDir('rt-observer-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const notes: { event: string; data: Record<string, unknown> }[] = [];
  const seen: AdapterEvent[] = [];
  await createSessionRuntime({
    note: (event, data) => notes.push({ event, data }),
    observer: tap,
  }).attach({
    task,
    binding: got.binding,
    adapter: fakeAdapter(),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    onEvent: (e) => seen.push(e),
    ...spec,
  }).done;
  registry.closeAll();
  return { notes, seen, sessionId, taskId: task.taskId };
}

function recording() {
  const got: { sessionId: string; text: string; inHistory: boolean }[] = [];
  const tap: ObserverTap = {
    onEvent: (_task, binding, event, meta) =>
      got.push({
        sessionId: binding.sessionId,
        text: (event as { text: string }).text,
        inHistory: meta.inHistory,
      }),
  };
  return { got, tap };
}

describe('session runtime observer tap', () => {
  it('a new session: every event, none in history', async () => {
    const { got, tap } = recording();
    const { sessionId, seen } = await runWith(tap, { resumed: false });
    expect(got).toEqual(['a', 'b', 'c'].map((text) => ({ sessionId, text, inHistory: false })));
    expect(seen).toEqual(EVENTS);
  });

  it('a resumed session: the first `replayed` events are history, the rest live', async () => {
    const { got, tap } = recording();
    await runWith(tap, { resumed: true, replayed: 2 });
    expect(got.map((g) => g.inHistory)).toEqual([true, true, false]);
  });

  it('a resumed session without a replay count: everything counts as history', async () => {
    const { got, tap } = recording();
    await runWith(tap, { resumed: true });
    expect(got.map((g) => g.inHistory)).toEqual([true, true, true]);
  });

  it('a throwing tap is noted per event and never breaks the stream', async () => {
    const { seen, notes, sessionId, taskId } = await runWith(
      {
        onEvent: () => {
          throw new Error('observer down');
        },
      },
      { resumed: false },
    );
    expect(seen).toEqual(EVENTS);
    expect(notes.filter((n) => n.event === 'observer.tap.failed')).toEqual(
      EVENTS.map(() => ({
        event: 'observer.tap.failed',
        data: { taskId, sessionId, reason: 'observer down' },
      })),
    );
  });
});
