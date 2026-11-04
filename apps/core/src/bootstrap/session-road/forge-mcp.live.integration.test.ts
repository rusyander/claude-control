import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { AdapterEvent } from '../../adapters/index.ts';
import { liveRoot, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { PROBE_SERVER, readProbe } from '../../adapters/conformance/__fixtures__/mcp-carry-run.ts';
import { fixturePath } from '../../adapters/conformance/__fixtures__/replay.ts';
import { CREATED, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createRouteRegistry } from '../../routes/registry.ts';
import { createStubRoute } from '../../routes/stub/stub.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { roadStart } from '../__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from '../boot.ts';

/**
 * Правило `forge-mcp-read-only` (P82, 05 §Only the core publishes) на НАСТОЯЩЕМ Claude Code дорогой
 * ядра: в `~/.claude.json` человека сервер форжа `gitlab-probe` (инструменты записи и чтения, оба с
 * `readOnlyHint` — самоописанию сервера правило не верит) и обычный сервер `human-notes`. Чат
 * панели (chat@1) берёт оба; человек разрешил все три инструмента своим правилом — отказ даёт
 * только ядро. Модель (заглушка маршрута ядра на петле) зовёт запись форжа, чтение форжа и запись
 * обычного сервера: до сервера форжа доходит только чтение, обычный сервер правило не трогает.
 */

const present = hasCli(claudeRunFacts.binary.command);
const FORGE = 'gitlab-probe';
const PLAIN = 'human-notes';
const WRITE = 'create_merge_request';
const READ = 'get_merge_request';
/** Не глагол чтения и не глагол записи: «не доказано, что читает» — тоже отказ. */
const UNKNOWN = 'gitlab_api_request';
const PLAIN_TOOL = 'create_note';
const full = (server: string, tool: string): string => `mcp__${server}__${tool}`;
const DONE = 'FORGE_MCP_DONE';

let core: BootedCore;
let live: LiveRoot;
const home = join(tempDir('road-forge-mcp-'), 'core');
const trace = join(home, 'stub-trace.jsonl');
const route = createStubRoute({
  name: 'forge-mcp',
  script: [
    { tool: { name: full(FORGE, WRITE), args: { note: 'write' } } },
    { tool: { name: full(FORGE, UNKNOWN), args: { note: 'unknown' } } },
    { tool: { name: full(FORGE, READ), args: { note: 'read' } } },
    { tool: { name: full(PLAIN, PLAIN_TOOL), args: { note: 'plain' } } },
    DONE,
  ],
  trace,
});

beforeAll(async () => {
  if (!present) return;
  core = await bootCore({
    home,
    build: 'road-forge-mcp-live',
    panelAppData: null,
    loop: false,
    routes: createRouteRegistry([route]),
  });
  live = liveRoot('road-forge-mcp-');
  const server = (log: string, tools: string) => ({
    type: 'stdio',
    command: process.execPath,
    args: [PROBE_SERVER],
    env: { PROBE_LOG: log, PROBE_TOOL: tools },
  });
  writeFileSync(
    join(live.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        [FORGE]: server(join(live.root, 'forge.log'), `${WRITE},${UNKNOWN},${READ}`),
        [PLAIN]: server(join(live.root, 'plain.log'), PLAIN_TOOL),
      },
    }),
  );
  mkdirSync(join(live.home, '.claude'), { recursive: true });
  writeFileSync(
    join(live.home, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: {
        allow: [
          full(FORGE, WRITE),
          full(FORGE, UNKNOWN),
          full(FORGE, READ),
          full(PLAIN, PLAIN_TOOL),
        ],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await core?.stop();
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 120_000);

async function until<T>(probe: () => T | undefined, what: () => string, ms = 150_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(what());
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface PermitLine {
  kind: string;
  data?: {
    class?: string;
    signal?: string;
    detail?: string;
    output?: { allow?: boolean; code?: string; target?: string; reason?: string };
  };
}

describe.skipIf(!present)(
  'real Claude session through the core road: forge-mcp-read-only (P82)',
  () => {
    it('the forge write and an unknown forge tool never reach the forge server (refused forge-mcp-write), the forge read does, a plain server write does', async () => {
      const task = await core.registry.create({
        ...CREATED,
        allowedRoutes: [
          { adapter: claudeRunFacts.id, route: { kind: 'stub', id: route.id }, modelPattern: '*' },
        ],
      });
      const bin = join(live.root, `bin-${newId()}`);
      mkdirSync(bin, { recursive: true });
      const start = {
        ...roadStart({
          live,
          bin,
          task,
          adapterId: claudeRunFacts.id,
          fixture: fixturePath(claudeRunFacts.id, 'permit'),
          dump: join(live.root, `unused-${newId()}.json`),
        }),
        routeId: route.id,
        stepKind: 'chat',
      };
      const prepared = await core.road.prepare(start);
      if (!prepared.ok) throw new Error(prepared.reason);
      const p = prepared.prepared;
      expect(Object.keys(p.spec.mcpServers)).toEqual(expect.arrayContaining([FORGE, PLAIN]));
      const lines = () =>
        readJournalLines(join(core.layout.tasks, task.taskId), task.taskId)
          .lines as unknown as PermitLine[];
      const note = lines().find((l) => l.kind === 'signal' && l.data?.signal === 'mcp-human');
      expect(note?.data?.detail).toContain(`forge read-only: ${FORGE} (name has «gitlab»)`);

      const launched = await core.road.launch(p);
      if (!launched.ok) throw new Error(launched.reason);
      core.road.started(p, launched.handle, launched.layer);
      const events: AdapterEvent[] = [];
      const session = core.road.attach({
        task,
        sessionId: p.start.sessionId,
        adapter: p.adapter,
        handle: launched.handle,
        context: p.context,
        cwd: p.start.cwd,
        onEvent: (event) => events.push(event),
      });
      try {
        await p.adapter.send(launched.handle, 'call the tools', `cmd-${newId()}`);
        const ended = await until(
          () => events.find((e) => e.type === 'turn.ended'),
          () => `no turn.ended; events ${events.map((e) => e.type).join(',')}`,
        );
        const diag = `ended=${JSON.stringify(ended)} trace=${existsSync(trace) ? readFileSync(trace, 'utf8').slice(-3000) : 'none'}`;
        expect(ended, diag).toMatchObject({ text: DONE });
        const forgeCalls = readProbe(join(live.root, 'forge.log'))
          .filter((e) => e.event === 'call')
          .map((e) => e.tool);
        const plainCalls = readProbe(join(live.root, 'plain.log'))
          .filter((e) => e.event === 'call')
          .map((e) => e.tool);
        expect(forgeCalls, diag).toEqual([READ]);
        expect(plainCalls, diag).toEqual([PLAIN_TOOL]);
        const permits = lines().filter((l) => l.kind === 'decision' && l.data?.class === 'permit');
        const refused = permits.find((l) => l.data?.output?.target === full(FORGE, WRITE));
        expect(refused?.data?.output, diag).toMatchObject({
          allow: false,
          code: 'forge-mcp-write',
        });
        expect(refused?.data?.output?.reason).toContain('forge-mcp-read-only');
        const unknown = permits.find((l) => l.data?.output?.target === full(FORGE, UNKNOWN));
        expect(unknown?.data?.output, diag).toMatchObject({
          allow: false,
          code: 'forge-mcp-write',
        });
        expect(unknown?.data?.output?.reason).toContain('not proven read-only');
        const read = permits.find((l) => l.data?.output?.target === full(FORGE, READ));
        expect(read?.data?.output).toMatchObject({ allow: true });
      } finally {
        await session.end('tree');
      }
    }, 240_000);
  },
);
