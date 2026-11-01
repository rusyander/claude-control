import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapters/index.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { createSessionRuntime, type UserLayerTap } from './session-runtime.ts';

/**
 * Кран слоя пользователя (этап 7, волна 0): рантайм отдаёт ему каждое событие потока сессии,
 * рядом с краном экономики. Сбой крана — строка `user-layer.tap.failed` в журнал ядра, поток
 * сессии идёт дальше: подписчик получает все события.
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

async function runWith(tap: UserLayerTap) {
  const registry = createTaskRegistry(tempDir('rt-user-layer-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const notes: { event: string; data: Record<string, unknown> }[] = [];
  const seen: AdapterEvent[] = [];
  await createSessionRuntime({
    note: (event, data) => notes.push({ event, data }),
    userLayer: tap,
  }).attach({
    task,
    binding: got.binding,
    adapter: fakeAdapter(),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    resumed: false,
    onEvent: (e) => seen.push(e),
  }).done;
  registry.closeAll();
  return { notes, seen, sessionId, taskId: task.taskId };
}

describe('session runtime user layer tap', () => {
  it('the tap gets every stream event with the session binding', async () => {
    const tapped: { sessionId: string; event: AdapterEvent }[] = [];
    const { seen, sessionId, notes } = await runWith({
      onEvent: (_task, binding, event) => tapped.push({ sessionId: binding.sessionId, event }),
    });
    expect(tapped).toEqual(EVENTS.map((event) => ({ sessionId, event })));
    expect(seen).toEqual(EVENTS);
    expect(notes.filter((n) => n.event === 'user-layer.tap.failed')).toEqual([]);
  });

  it('a throwing tap is noted per event and never breaks the stream', async () => {
    const { seen, notes, sessionId, taskId } = await runWith({
      onEvent: () => {
        throw new Error('tap down');
      },
    });
    expect(seen).toEqual(EVENTS);
    expect(notes.filter((n) => n.event === 'user-layer.tap.failed')).toEqual(
      EVENTS.map(() => ({
        event: 'user-layer.tap.failed',
        data: { taskId, sessionId, reason: 'tap down' },
      })),
    );
  });
});
