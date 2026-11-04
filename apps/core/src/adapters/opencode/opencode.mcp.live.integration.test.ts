import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import { carryScript, expectCarried, runCarry } from '../conformance/__fixtures__/mcp-carry-run.ts';
import {
  expectHumanOffered,
  HUMAN_PICKED,
  runHumanCarry,
} from '../conformance/__fixtures__/mcp-human-run.ts';
import {
  expectRemoteCarried,
  REMOTE_SERVER,
  runRemoteCarry,
} from '../conformance/__fixtures__/mcp-remote-run.ts';
import { sessionMcp } from '../../bootstrap/session-road/mcp-list.ts';
import { toolTurns } from '../conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from '../conformance/__fixtures__/p81-stand.ts';
import { createOpencodeAdapter, OPENCODE_CHANNELS } from './opencode.ts';

/**
 * Живой opencode (`opencode acp`): серверы MCP шага доходят ключом `mcp` конфига сеанса
 * (`type: "local"`, s10 p6). Модель вызывает инструмент перенесённого сервера; запись сервера права
 * и серверы MCP человека (`~/.config/opencode/opencode.json`) и репозитория (`opencode.json`) не
 * стартуют.
 */

const present = hasCli(opencodeRunFacts.binary.command);
let live: LiveRoot;
let human: LiveRoot;
let remote: LiveRoot | undefined;
let stub: StubModel;
let core: FakeCore;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('opencode-mcp-');
  human = liveRoot('opencode-mcp-human-');
  core = await startFakeCore();
  stub = await startStubModel({ script: carryScript(requests, toolTurns) });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await core?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
  if (human) rmSync(human.root, { recursive: true, force: true, maxRetries: 5 });
  if (remote) rmSync(remote.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

describe.skipIf(!present)('opencode adapter on the real CLI — MCP carriage', () => {
  it('a carried MCP server is called by the model; permit entry and human/repo servers are absent', async () => {
    expectCarried(
      await runCarry({
        live,
        core,
        requests,
        adapter: createOpencodeAdapter({ pollMs: 20 }),
        channel: OPENCODE_CHANNELS[0]!,
        dialect: 'openai-chat',
        baseUrl: stub.baseUrl,
        keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
      }),
    );
  }, 240_000);

  it('a human server from its own config: offered, the picked one is called, the unpicked never starts (P73)', async () => {
    requests.length = 0;
    const r = await runHumanCarry({
      cli: 'opencode',
      select: (source) => sessionMcp('work', 'stub', source, { work: [HUMAN_PICKED] }).human,
      live: human,
      core,
      requests,
      adapter: createOpencodeAdapter({ pollMs: 20 }),
      channel: OPENCODE_CHANNELS[0]!,
      dialect: 'openai-chat',
      baseUrl: stub.baseUrl,
      keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
    });
    expectHumanOffered(r);
    expectCarried(r);
  }, 240_000);

  it('a remote human server (type remote, headers with {env:X}): opencode connects over streamable HTTP with both headers and calls its tool (s10 p9)', async () => {
    requests.length = 0;
    remote = liveRoot('opencode-mcp-remote-');
    expectRemoteCarried(
      await runRemoteCarry({
        cli: 'opencode',
        select: (source) => sessionMcp('work', 'stub', source, { work: [REMOTE_SERVER] }).human,
        live: remote,
        core,
        requests,
        adapter: createOpencodeAdapter({ pollMs: 20 }),
        channel: OPENCODE_CHANNELS[0]!,
        dialect: 'openai-chat',
        baseUrl: stub.baseUrl,
        keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
      }),
    );
  }, 240_000);
});
