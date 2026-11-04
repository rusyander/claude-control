import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import { sessionStreamPageSchema } from '@agentdeck/contracts/core/session-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import { IO_RECORD } from '../adapters/sdk-stream/io-record.ts';
import { fixturePath } from '../adapters/conformance/__fixtures__/replay.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Вид сеанса `GET /v1/tasks/:id/sessions/:sid/stream` (этап 10) на настоящем API, журнале и
 * нормализаторах переходников claude и qwen: `stdout.log` — записанный поток настоящего CLI
 * (фикстуры набора соответствия), ход человека — из `core-io.jsonl` на своём смещении.
 */

const A = '11111111-1111-4111-8111-111111111111';
let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

function seedSession(s: Stand, adapter: string, fixture: string | null): string {
  const task = s.registry.live(s.taskId)!;
  const sessionId = newId();
  task.append({
    kind: 'session.started',
    actor: 'core',
    sessionId,
    data: {
      sessionId,
      stepId: newId(),
      adapter,
      cliVersion: '1',
      route: { kind: 'cli-login', id: 'login' },
      hops: [],
      credentialKind: 'none',
      modelAsked: null,
      modelServed: null,
      effort: null,
      hostPid: process.pid,
      hostStart: 'start',
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  const dir = join(s.layout.tasks, s.taskId, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  if (fixture) {
    copyFileSync(fixture, join(dir, 'stdout.log'));
    const data = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello one' } });
    writeFileSync(
      join(dir, IO_RECORD),
      `${JSON.stringify({ t: 'send', cmdId: A, uuid: A, at: 0, data })}\n`,
    );
  }
  return sessionId;
}

async function page(s: Stand, sid: string, from?: number) {
  const q = from === undefined ? '' : `?from=${from}`;
  const res = await s.get(`/v1/tasks/${s.taskId}/sessions/${sid}/stream${q}`);
  return { status: res.status, body: (await res.json()) as SessionStreamPage & { code?: string } };
}

describe('GET /v1/tasks/:id/sessions/:sid/stream (stage 10)', () => {
  it.each(['claude', 'qwen'])(
    '%s: the human turn first, then the assistant text and the turn end; the next page from `next` is empty',
    async (adapter) => {
      stand = await startStand(undefined, { adapters: createAdapterRegistry() });
      const sid = seedSession(stand, adapter, fixturePath(adapter, 'basic'));
      const first = await page(stand, sid);
      expect(first.status).toBe(200);
      expect(sessionStreamPageSchema.safeParse(first.body).success).toBe(true);
      const kinds = first.body.events.map((e) => e.kind);
      expect(first.body.events[0]).toEqual({
        offset: 0,
        kind: 'user-text',
        data: { text: 'hello one' },
      });
      expect(kinds).toContain('assistant-text');
      // Конец хода — после текста ответа: ход читается целиком, а не обрывком.
      expect(kinds.lastIndexOf('turn-end')).toBeGreaterThan(kinds.indexOf('assistant-text'));
      expect(first.body).toMatchObject({ adapter, done: false });
      const offsets = first.body.events.map((e) => e.offset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      const again = await page(stand, sid, first.body.next);
      expect(again.body.events).toEqual([]);
      expect(again.body.next).toBe(first.body.next);
      // Середина потока: только события от смещения, без хода человека на нуле.
      const mid = first.body.events.find((e) => e.kind === 'assistant-text')!.offset;
      const tail = await page(stand, sid, mid);
      expect(tail.body.events[0]?.offset).toBe(mid);
      expect(tail.body.events.some((e) => e.kind === 'user-text')).toBe(false);
    },
  );

  it('done only after the session ended and the log is read to its end', async () => {
    stand = await startStand(undefined, { adapters: createAdapterRegistry() });
    const sid = seedSession(stand, 'claude', fixturePath('claude', 'basic'));
    const task = stand.registry.live(stand.taskId)!;
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId: sid,
      data: { sessionId: sid, event: 'exited', from: 'starting', to: 'ended' },
    });
    expect((await page(stand, sid)).body.done).toBe(true);
  });

  it('refusals: unknown session 404, no adapter registry 501, a bad offset 400', async () => {
    stand = await startStand(undefined, { adapters: createAdapterRegistry() });
    expect((await page(stand, newId())).body.code).toBe('unknown-session');
    const sid = seedSession(stand, 'claude', null);
    const bad = await stand.get(`/v1/tasks/${stand.taskId}/sessions/${sid}/stream?from=-1`);
    expect(bad.status).toBe(400);
    const empty = await page(stand, sid);
    expect(empty.body).toMatchObject({ events: [], next: 0, done: false });
    await stand.close();
    stand = await startStand();
    const sid2 = seedSession(stand, 'claude', null);
    const none = await page(stand, sid2);
    expect({ status: none.status, code: none.body.code }).toEqual({
      status: 501,
      code: 'no-normaliser',
    });
  });
});
