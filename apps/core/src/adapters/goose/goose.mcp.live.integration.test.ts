import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';
import { carryScript, expectCarried, runCarry } from '../conformance/__fixtures__/mcp-carry-run.ts';
import {
  expectHumanOffered,
  HUMAN_PICKED,
  runHumanCarry,
} from '../conformance/__fixtures__/mcp-human-run.ts';
import { sessionMcp } from '../../bootstrap/session-road/mcp-list.ts';
import { toolTurns } from '../conformance/__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from '../conformance/__fixtures__/p81-stand.ts';
import { createGooseAdapter, GOOSE_CHANNELS } from './goose.ts';

/**
 * Живой Goose (1.54, `goose acp`): серверы MCP шага доходят через ACP `session/new` (s10 p6).
 * Модель (stub-model) вызывает инструмент перенесённого сервера — вызов дошёл до процесса сервера;
 * запись сервера права и серверы MCP человека и репозитория не стартуют и модели не видны.
 */

const present = hasCli(gooseRunFacts.binary.command);
let live: LiveRoot;
let human: LiveRoot;
let stub: StubModel;
let core: FakeCore;
const requests: string[] = [];

beforeAll(async () => {
  if (!present) return;
  live = liveRoot('goose-mcp-');
  human = liveRoot('goose-mcp-human-');
  core = await startFakeCore();
  stub = await startStubModel({ script: carryScript(requests, toolTurns) });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await core?.close();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
  if (human) rmSync(human.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

describe.skipIf(!present)('goose adapter on the real CLI — MCP carriage', () => {
  it('a carried MCP server is called by the model; permit entry and human/repo servers are absent', async () => {
    expectCarried(
      await runCarry({
        live,
        core,
        requests,
        adapter: createGooseAdapter({ pollMs: 20 }),
        channel: GOOSE_CHANNELS[0]!,
        dialect: 'openai-chat',
        baseUrl: stub.baseUrl,
        keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
      }),
    );
  }, 240_000);

  it('a human server from its own config: offered, the picked one is called, the unpicked never starts (P73)', async () => {
    requests.length = 0;
    const r = await runHumanCarry({
      cli: 'goose',
      select: (source) => sessionMcp('work', 'stub', source, { work: [HUMAN_PICKED] }).human,
      live: human,
      core,
      requests,
      adapter: createGooseAdapter({ pollMs: 20 }),
      channel: GOOSE_CHANNELS[0]!,
      dialect: 'openai-chat',
      baseUrl: stub.baseUrl,
      keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
    });
    expectHumanOffered(r);
    expectCarried(r);
  }, 240_000);
});
