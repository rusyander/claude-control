import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, PermitCodec, SessionHandle } from '../adapters/index.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { createSessionRuntime } from './session-runtime.ts';

/**
 * core-s2 F-42: вопрос о праве строкой протокола, на котором кодек или ответ падает, не
 * остаётся без ответа — CLI получает отказ, а если и отказ не написать, сессия снимается, а не
 * ждёт сторожа простоя.
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

interface Seen {
  replies: unknown[];
  stops: string[];
  notes: string[];
}

function adapter(codec: PermitCodec, seen: Seen, answerFails = false): CliAdapter {
  const events: AdapterEvent[] = [{ type: 'permit.request', requestId: 'r1', raw: { any: 1 } }];
  return {
    id: 'fake',
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: () => ({ action: 'other', target: '', tool: '', display: '' }),
    permitCodec: codec,
    answerPermit: async (_h: SessionHandle, _id: string, reply: unknown) => {
      if (answerFails) throw new Error('write boom');
      seen.replies.push(reply);
    },
    stop: async (_h: SessionHandle, mode: string) => {
      seen.stops.push(mode);
      return { how: 'exited', residual: [], code: 0 };
    },
  } as unknown as CliAdapter;
}

async function run(codec: PermitCodec, answerFails = false): Promise<Seen> {
  const registry = createTaskRegistry(tempDir('rt-permit-fail-'), deps());
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const seen: Seen = { replies: [], stops: [], notes: [] };
  const attached = createSessionRuntime({
    settleMs: 10,
    note: (event, data) => seen.notes.push(`${event}:${String(data.reason)}`),
  }).attach({
    task,
    binding: got.binding,
    adapter: adapter(codec, seen, answerFails),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
  });
  await attached.done;
  for (let i = 0; i < 100 && seen.replies.length + seen.stops.length === 0; i += 1) {
    await new Promise((d) => setTimeout(d, 10));
  }
  return seen;
}

const DENY = { deny: true };

describe('core-s2 session runtime — a failing in-band permit still answers', () => {
  it('F-42 codec.read throws → the CLI gets the codec-rendered deny, the failure is noted', async () => {
    const seen = await run({
      read: () => {
        throw new Error('codec read boom');
      },
      render: (answer) => (answer.allow ? { allow: true } : DENY),
    });
    expect(seen.replies).toEqual([DENY]);
    expect(seen.stops).toEqual([]);
    expect(seen.notes.some((n) => n.includes('codec read boom'))).toBe(true);
  });

  it('F-42 the deny cannot be rendered or written either → the session is stopped, not left waiting', async () => {
    const seen = await run({
      read: () => undefined,
      render: () => {
        throw new Error('codec render boom');
      },
    });
    expect(seen.replies).toEqual([]);
    expect(seen.stops).toEqual(['soft']);
    const written = await run(
      { read: () => undefined, render: (a) => (a.allow ? { allow: true } : DENY) },
      true,
    );
    expect(written.stops).toEqual(['soft']);
  });
});
