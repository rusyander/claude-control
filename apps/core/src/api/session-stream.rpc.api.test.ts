import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import { sessionStreamPageSchema } from '@agentdeck/contracts/core/session-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import { rpcFixturePath } from '../adapters/conformance/__fixtures__/rpc-replay.ts';
import { IO_RECORD } from '../adapters/sdk-stream/io-record.ts';
import { RPC_VIEW } from '../adapters/rpc-stdio/rpc-view.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Вид сеанса CLI JSON-RPC по stdio (этап 10, зона G4) на настоящем API и реестре переходников:
 * `stdout.log` — то, что записанный живой CLI (Codex `app-server`, ACP Goose/OpenCode/Kimi/Gemini)
 * писал в stdout; ходы ядра — его же строки `turn/start` / `session/prompt` в `core-io.jsonl` на
 * смещении, где насос их отправил; вход диалекта — `rpc-view.json`, как его кладёт запуск.
 * До зоны G4 каждый такой сеанс отвечал 501 `no-normaliser`.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const TURN_METHODS = new Set(['turn/start', 'session/prompt']);

interface Tee {
  meta: { hookCommand?: string; cwd?: string };
  lines: { d: 'in' | 'out'; line: string }[];
}

function readTee(file: string): Tee {
  const [head, ...rest] = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return {
    meta: (JSON.parse(head as string) as { meta: Tee['meta'] }).meta,
    lines: rest.map((l) => JSON.parse(l) as Tee['lines'][number]),
  };
}

/** Вход диалекта, как его пишет запуск переходника (без брифа и значений MCP). */
function viewInputOf(adapter: string, meta: Tee['meta']): Record<string, unknown> {
  const cwd = meta.cwd ?? '/w';
  if (adapter === 'codex') {
    return {
      cwd,
      hookCommand: meta.hookCommand,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: '',
      permit: 'core',
    };
  }
  return { cli: adapter, cwd, permit: 'core' };
}

function seedRpcSession(s: Stand, adapter: string, fixture: string, view = true): string {
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
  const tee = readTee(fixture);
  let stdout = '';
  const io: string[] = [];
  for (const { d, line } of tee.lines) {
    if (d === 'out') {
      stdout += `${line}\n`;
      continue;
    }
    const msg = JSON.parse(line) as { method?: string; params?: { clientUserMessageId?: string } };
    if (!msg.method || !TURN_METHODS.has(msg.method)) continue;
    const cmdId = msg.params?.clientUserMessageId ?? newId();
    const at = Buffer.byteLength(stdout);
    io.push(JSON.stringify({ t: 'send', cmdId, uuid: cmdId, at, data: line }));
    io.push(JSON.stringify({ t: 'ack', cmdId }));
  }
  writeFileSync(join(dir, 'stdout.log'), stdout);
  writeFileSync(join(dir, IO_RECORD), `${io.join('\n')}\n`);
  if (view) writeFileSync(join(dir, RPC_VIEW), JSON.stringify(viewInputOf(adapter, tee.meta)));
  return sessionId;
}

async function page(s: Stand, sid: string, from?: number) {
  const q = from === undefined ? '' : `?from=${from}`;
  const res = await s.get(`/v1/tasks/${s.taskId}/sessions/${sid}/stream${q}`);
  return { status: res.status, body: (await res.json()) as SessionStreamPage & { code?: string } };
}

const FAMILIES: [adapter: string, fixture: string, said: [string, string]][] = [
  ['codex', 'basic', ['FIRST_TURN say one', 'SECOND_TURN say two']],
  ['goose', 'basic', ['FIRST_TURN say one', 'SECOND_TURN say two']],
  ['opencode', 'basic', ['FIRST_TURN say one', 'SECOND_TURN say two']],
  ['kimi', 'acp-basic', ['FIRST do it', 'SECOND do it']],
  ['gemini', 'acp-basic', ['FIRST do it', 'SECOND do it']],
];

describe('GET /v1/tasks/:id/sessions/:sid/stream — rpc-stdio CLIs (stage 10 G4)', () => {
  it.each(FAMILIES)(
    '%s: each human turn, then its answer and a clean turn end; the next page from `next` is empty',
    async (adapter, fixture, said) => {
      stand = await startStand(undefined, { adapters: createAdapterRegistry() });
      const sid = seedRpcSession(stand, adapter, rpcFixturePath(adapter, fixture));
      const first = await page(stand, sid);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(sessionStreamPageSchema.safeParse(first.body).success).toBe(true);
      const events = first.body.events;
      // Ни одной ошибки разбора: рукопожатие повтора сошлось с записанным.
      expect(events.filter((e) => e.kind === 'error')).toEqual([]);
      const turns = events.reduce<{ said: string; text: string; end?: unknown }[]>((acc, e) => {
        const data = e.data as { text?: string };
        if (e.kind === 'user-text') acc.push({ said: data.text ?? '', text: '' });
        else if (e.kind === 'assistant-text' && acc.length) acc.at(-1)!.text += data.text ?? '';
        else if (e.kind === 'turn-end' && acc.length) acc.at(-1)!.end = e.data;
        return acc;
      }, []);
      expect(turns).toEqual([
        {
          said: expect.stringContaining(said[0]),
          text: 'ANSWER_ONE',
          end: expect.objectContaining({ isError: false }),
        },
        {
          said: expect.stringContaining(said[1]),
          text: 'ANSWER_TWO',
          end: expect.objectContaining({ isError: false }),
        },
      ]);
      const offsets = events.map((e) => e.offset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
      const again = await page(stand, sid, first.body.next);
      expect(again.body.events).toEqual([]);
    },
  );

  it('a session without its recorded view input: named 501 no-view, never an empty page', async () => {
    stand = await startStand(undefined, { adapters: createAdapterRegistry() });
    const sid = seedRpcSession(stand, 'goose', rpcFixturePath('goose', 'basic'), false);
    const res = await page(stand, sid);
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 501, code: 'no-view' });
  });
});
