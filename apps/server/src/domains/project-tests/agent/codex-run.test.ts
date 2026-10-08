import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runScope, type RunPermissionGate } from '../run-permissions/run-permissions.ts';
import type { TestsAgentEvent } from './agent-run.types.ts';
import { CodexTestsRun } from './codex-run.ts';

/**
 * Прогон тестов на Codex — против поддельного `codex app-server`: JSON-RPC
 * строками по stdio, формы сообщений — из проб (`.agent/tmp/tests-agent-probes/`).
 * Главное: правка вне границ — «нет», и причина уходит в ход ДО ответа «нет».
 */
const ROOT = resolve(tmpdir(), 'cc-codex-run-root');
const at = (...parts: string[]): string => join(ROOT, ...parts);

interface Wire {
  /** Всё, что клиент написал серверу, по порядку. */
  sent: Record<string, unknown>[];
  argv: string[];
  cwd?: string;
}

interface Peer {
  notify(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Конец хода — `turn/completed`. */
  complete(status?: 'completed' | 'failed', error?: string): void;
}

function fakeCodex(
  wire: Wire,
  scenario: (peer: Peer) => Promise<void>,
  options: { silentInit?: boolean } = {},
): typeof nodeSpawn {
  return ((_command: string, args: string[], spawnOptions: Record<string, unknown>) => {
    wire.argv = args;
    wire.cwd = spawnOptions.cwd as string;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: number;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 626262;
    const out = (message: object): void => {
      child.stdout.write(`${JSON.stringify(message)}\n`);
    };
    let nextId = 1000;
    const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
    const peer: Peer = {
      notify: (method, params) => out({ method, params }),
      request: (method, params) =>
        new Promise((done) => {
          const id = nextId++;
          waiting.set(id, done);
          out({ id, method, params });
        }),
      complete: (status = 'completed', error) =>
        out({
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status, error: error ? { message: error } : null } },
        }),
    };
    let buffer = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const message = JSON.parse(buffer.slice(0, cut)) as Record<string, unknown> & {
          id?: number;
          method?: string;
        };
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf('\n');
        wire.sent.push(message);
        if (message.method === undefined && typeof message.id === 'number') {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
          continue;
        }
        if (message.id === undefined) continue;
        const reply = (result: object): void => out({ id: message.id, result });
        if (message.method === 'initialize' && !options.silentInit) reply({ userAgent: 'codex' });
        if (message.method === 'thread/start') reply({ thread: { id: 'thread-1' } });
        if (message.method === 'turn/steer') reply({ turnId: 'turn-1' });
        if (message.method === 'turn/start') {
          reply({ turn: { id: 'turn-1' } });
          setImmediate(() => void scenario(peer));
        }
      }
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

const gate: RunPermissionGate = {
  baseUrl: 'http://127.0.0.1:9',
  runId: 'r',
  decided: () => undefined,
  close: () => {},
};

async function run(
  scenario: (peer: Peer) => Promise<void>,
  options: { silentInit?: boolean } = {},
): Promise<{ events: TestsAgentEvent[]; wire: Wire; denials: string[]; kills: number }> {
  const events: TestsAgentEvent[] = [];
  const wire: Wire = { sent: [], argv: [] };
  const denials: string[] = [];
  let kills = 0;
  const agent = new CodexTestsRun({
    kill: () => (kills += 1),
    handshakeMs: options.silentInit ? 50 : undefined,
    steerWaitMs: 500,
  });
  await agent.start(
    {
      command: process.execPath,
      providerName: 'Codex',
      prompt: 'Прогони кейсы',
      cwd: ROOT,
      env: { STAND_TOKEN: 's3cret' },
      gate,
      scope: runScope(ROOT, 'run'),
      onDeny: (tool, message) => denials.push(`${tool}: ${message}`),
      spawnImpl: fakeCodex(wire, scenario, options),
    },
    (event) => events.push(event),
  );
  return { events, wire, denials, kills };
}

const fileChange = (id: string, path: string, type = 'add', movePath?: string) => ({
  item: {
    id,
    type: 'fileChange',
    changes: [{ path, kind: { type, ...(movePath ? { move_path: movePath } : {}) }, diff: '' }],
  },
});

/** Метод и, у ответа, решение — по порядку всего, что клиент сказал серверу. */
function trail(wire: Wire): string[] {
  return wire.sent.map((message) => {
    if (message.method) return String(message.method);
    const result = message.result as Record<string, unknown> | undefined;
    if (message.error) return 'reply:error';
    if (result && 'decision' in result) return `reply:${JSON.stringify(result.decision)}`;
    if (result && 'action' in result) return `reply:${String(result.action)}`;
    return 'reply';
  });
}

describe('project-tests/agent/codex-run', () => {
  it('рукопожатие по порядку; поток — untrusted + read-only + ephemeral в корне проекта', async () => {
    const { wire, events } = await run(async (peer) => peer.complete());
    expect(wire.argv).toEqual(['app-server']);
    expect(wire.cwd).toBe(ROOT);
    expect(trail(wire)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    const thread = wire.sent.find((message) => message.method === 'thread/start');
    expect(thread?.params).toEqual({
      cwd: ROOT,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      ephemeral: true,
    });
    const turn = wire.sent.find((message) => message.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Прогони кейсы' }],
    });
    expect(events.at(-1)).toMatchObject({ kind: 'done', costUsd: 0, sessionId: '' });
  });

  it('правка в границах — accept, без сообщения в ход', async () => {
    const { wire } = await run(async (peer) => {
      peer.notify(
        'item/started',
        fileChange('fc-1', at('.agent', 'tests', 'login.tests.json'), 'update'),
      );
      await peer.request('item/fileChange/requestApproval', { itemId: 'fc-1', reason: null });
      peer.complete();
    });
    expect(trail(wire)).toContain('reply:"accept"');
    expect(trail(wire)).not.toContain('turn/steer');
  });

  it('правка вне границ — причина в ход (turn/steer) ДО ответа decline; acceptForSession нет', async () => {
    const { wire, denials } = await run(async (peer) => {
      peer.notify('item/started', fileChange('fc-2', at('src', 'evil.ts')));
      await peer.request('item/fileChange/requestApproval', { itemId: 'fc-2', reason: null });
      peer.complete();
    });
    const steps = trail(wire);
    expect(steps.indexOf('turn/steer')).toBeGreaterThan(-1);
    expect(steps.indexOf('turn/steer')).toBeLessThan(steps.indexOf('reply:"decline"'));
    const steer = wire.sent.find((message) => message.method === 'turn/steer');
    expect(steer?.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1' });
    expect(JSON.stringify(steer?.params)).toMatch(/refused the apply_patch/);
    expect(JSON.stringify(wire.sent)).not.toContain('acceptForSession');
    expect(denials).toHaveLength(1);
  });

  it('перенос из границ наружу и незнакомый id элемента — decline', async () => {
    const { wire } = await run(async (peer) => {
      peer.notify(
        'item/started',
        fileChange('fc-3', at('.agent', 'tests', 'a.tests.json'), 'update', at('src', 'a.ts')),
      );
      await peer.request('item/fileChange/requestApproval', { itemId: 'fc-3', reason: null });
      await peer.request('item/fileChange/requestApproval', { itemId: 'nobody', reason: null });
      peer.complete();
    });
    expect(trail(wire).filter((step) => step === 'reply:"decline"')).toHaveLength(2);
  });

  it('устаревший applyPatchApproval: вне границ — denied с причиной, в границах — approved', async () => {
    const { wire } = await run(async (peer) => {
      await peer.request('applyPatchApproval', {
        fileChanges: { [at('src', 'evil.ts')]: { type: 'add' } },
      });
      await peer.request('applyPatchApproval', {
        fileChanges: { [at('.agent', 'tests', 'b.tests.json')]: { type: 'update' } },
      });
      peer.complete();
    });
    const replies = wire.sent.filter(
      (message) => message.result && 'decision' in (message.result as object),
    );
    expect((replies[0]?.result as { decision: unknown }).decision).toMatchObject({
      denied: { rejection: expect.any(String) },
    });
    expect((replies[1]?.result as { decision: unknown }).decision).toBe('approved');
  });

  it('команды: правка истории git — decline с причиной; прочее — accept', async () => {
    const { wire } = await run(async (peer) => {
      await peer.request('item/commandExecution/requestApproval', {
        itemId: 'c1',
        command: `"pwsh.exe" -Command 'git commit -am x'`,
        commandActions: [{ type: 'unknown', command: 'git commit -am x' }],
      });
      await peer.request('item/commandExecution/requestApproval', {
        itemId: 'c2',
        command: `"pwsh.exe" -Command 'npm test'`,
        commandActions: [{ type: 'unknown', command: 'npm test' }],
      });
      peer.complete();
    });
    const steps = trail(wire);
    expect(steps.filter((step) => step.startsWith('reply:"'))).toEqual([
      'reply:"decline"',
      'reply:"accept"',
    ]);
    expect(steps.indexOf('turn/steer')).toBeLessThan(steps.indexOf('reply:"decline"'));
  });

  it('вопрос человеку — ошибка «спросить некого»; MCP — decline; права — пустой набор', async () => {
    const { wire } = await run(async (peer) => {
      await peer.request('item/tool/requestUserInput', { questions: [] });
      await peer.request('mcpServer/elicitation/request', { serverName: 'x', message: 'call?' });
      await peer.request('item/permissions/requestApproval', { permissions: { network: true } });
      await peer.request('some/unknown/request', {});
      peer.complete();
    });
    const replies = wire.sent.filter((message) => message.method === undefined);
    expect(replies.map((reply) => (reply.error ? 'error' : JSON.stringify(reply.result)))).toEqual([
      'error',
      JSON.stringify({ action: 'decline' }),
      JSON.stringify({ permissions: {}, scope: 'turn' }),
      'error',
    ]);
    expect(JSON.stringify(replies[0]?.error)).toMatch(/Nobody to ask/);
  });

  it('расход — из tokenUsage.last, кэш не считается дважды; текст — целым сообщением', async () => {
    const { events } = await run(async (peer) => {
      peer.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'Пароль s3' });
      peer.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'cret не печатаю' });
      peer.notify('item/completed', { item: { id: 'm1', type: 'agentMessage', text: '' } });
      peer.notify('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 },
          total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 },
        },
      });
      peer.complete();
    });
    expect(events.filter((event) => event.kind === 'text')).toEqual([
      { kind: 'text', text: 'Пароль s3cret не печатаю\n' },
    ]);
    expect(events).toContainEqual({
      kind: 'usage',
      input: 600,
      output: 50,
      cacheRead: 400,
      cacheCreation: 0,
    });
  });

  it('ход кончился ошибкой — error с причиной Codex', async () => {
    const { events, kills } = await run(async (peer) => peer.complete('failed', 'model 401'));
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'model 401' });
    expect(kills).toBe(1);
  });

  it('app-server молчит на initialize — отказ с кодом, без запасного запуска', async () => {
    const { events, wire } = await run(async () => {}, { silentInit: true });
    expect(trail(wire)).toEqual(['initialize']);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'error',
        messageCode: 'tests-agent-codex-app-server-unavailable',
        params: { why: 'initialize не ответил' },
      }),
    ]);
  });
});
