import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGooseAdapter } from '../goose/goose.ts';
import { IO_RECORD } from '../sdk-stream/io-record.ts';
import { replaySession } from '../sdk-stream/stream-view.ts';
import { acpViewInput, type AcpDialectData } from './acp.ts';
import { NoSessionView, RPC_VIEW, rpcTurnText } from './rpc-view.ts';

/**
 * Вид сеанса CLI JSON-RPC (этап 10, G4): вход запуска из `rpc-view.json` решает разбор так же,
 * как у живого насоса — продолжение (`session/load`) не показывает проигранную историю, режим
 * права даёт ту же форму вопроса; на диск не ложатся значения серверов MCP.
 */

const A = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rpc = (msg: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', ...msg });
const chunk = (text: string): string =>
  rpc({
    method: 'session/update',
    params: {
      sessionId: 'S1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
const INIT = rpc({
  id: 1,
  result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
});
const MODES = { modes: { currentModeId: 'approve' } };

/** Сеанс на диске: строки stdout, отправка ядра на смещении перед строкой `turnAt`. */
function session(view: AcpDialectData | null, lines: string[], turnAt: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-view-'));
  dirs.push(dir);
  const before = lines
    .slice(0, turnAt)
    .map((l) => `${l}\n`)
    .join('');
  writeFileSync(join(dir, 'stdout.log'), lines.map((l) => `${l}\n`).join(''));
  const data = rpc({
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'S1', prompt: [{ type: 'text', text: 'NEW_TURN' }] },
  });
  writeFileSync(
    join(dir, IO_RECORD),
    `${JSON.stringify({ t: 'send', cmdId: A, uuid: A, at: Buffer.byteLength(before), data })}\n`,
  );
  if (view) writeFileSync(join(dir, RPC_VIEW), JSON.stringify(view));
  return dir;
}

const viewOfDir = (dir: string) =>
  replaySession(dir, createGooseAdapter().streamNormaliser!(dir), 0).events.map((e) => ({
    kind: e.kind,
    data: e.data,
  }));

describe('rpc-stdio session view', () => {
  it('a resumed ACP session: the replayed history stays out, only the new turn shows', () => {
    const lines = [
      INIT,
      chunk('OLD_ANSWER'),
      rpc({ id: 2, result: MODES }),
      chunk('NEW_ANSWER'),
      rpc({ id: 3, result: { stopReason: 'end_turn' } }),
    ];
    const dir = session({ cli: 'goose', cwd: 'C:\\w', permit: 'core', load: 'S1' }, lines, 3);
    expect(viewOfDir(dir)).toEqual([
      { kind: 'user-text', data: { text: 'NEW_TURN' } },
      { kind: 'assistant-text', data: { text: 'NEW_ANSWER' } },
      { kind: 'turn-end', data: { isError: false, numTurns: 1 } },
    ]);
  });

  it('the recorded permit mode decides the view of an ask: refuse → denied ask, core → a request', () => {
    const ask = rpc({
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 'S1',
        toolCall: { toolCallId: 't1', title: 'shell', rawInput: { command: 'echo hi' } },
        options: [{ optionId: 'no', kind: 'reject_once' }],
      },
    });
    const lines = [INIT, rpc({ id: 2, result: { sessionId: 'S1', ...MODES } }), ask];
    const refused = viewOfDir(session({ cli: 'goose', cwd: 'C:\\w', permit: 'refuse' }, lines, 2));
    expect(refused.find((e) => e.kind === 'permission')?.data).toMatchObject({ denied: true });
    const core = viewOfDir(session({ cli: 'goose', cwd: 'C:\\w', permit: 'core' }, lines, 2));
    expect(core.find((e) => e.kind === 'permission')?.data).toMatchObject({
      requestId: 'goose:7',
    });
  });

  it('no recorded view input: a named NoSessionView, never an empty view', () => {
    const dir = session(null, [INIT], 1);
    expect(() => createGooseAdapter().streamNormaliser!(dir)).toThrow(NoSessionView);
  });

  it('view input on disk keeps MCP server names and transports, never commands, urls, env or headers', () => {
    const kept = acpViewInput({
      cli: 'goose',
      cwd: 'C:\\w',
      permit: 'core',
      mcpServers: [
        { name: 'local', command: 'node', args: ['s.mjs'], env: [{ name: 'T', value: 'secret' }] },
        {
          type: 'http',
          name: 'remote',
          url: 'https://h/?k=secret',
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
        },
      ],
    });
    expect(JSON.stringify(kept)).not.toContain('secret');
    expect(kept.mcpServers).toEqual([
      { name: 'local', command: '', args: [], env: [] },
      { type: 'http', name: 'remote', url: '', headers: [] },
    ]);
  });

  it('turn text: codex `input` blocks, ACP `prompt` blocks, anything else as written', () => {
    expect(
      rpcTurnText(JSON.stringify({ id: 5, params: { input: [{ type: 'text', text: 'a' }] } })),
    ).toBe('a');
    expect(rpcTurnText(rpc({ id: 3, params: { prompt: [{ type: 'text', text: 'b' }] } }))).toBe(
      'b',
    );
    expect(rpcTurnText('plain')).toBe('plain');
  });
});
