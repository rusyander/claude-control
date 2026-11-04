import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { AdapterEvent } from '../../adapters/index.ts';
import { liveRoot, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import {
  CARRY_TOOL,
  PROBE_SERVER,
  readProbe,
  STRAY_TOOL,
} from '../../adapters/conformance/__fixtures__/mcp-carry-run.ts';
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
 * Чат панели (chat@1) с серверами MCP человека на НАСТОЯЩЕМ Claude Code дорогой ядра (s10 p9,
 * паритет старого чата панели): в `~/.claude.json` человека два stdio-сервера, `mcpPicks.chat` нет —
 * дорога берёт оба («picked by default (chat)» в журнале), `--mcp-config` сеанса несёт их, CLI
 * поднимает сервер, модель (заглушка маршрута ядра) вызывает его инструмент. Ни один ключ не
 * тратится: маршрут — заглушка ядра на петле, дом CLI — временный.
 */

const present = hasCli(claudeRunFacts.binary.command);
const PICKED = 'human-picked';
const OTHER = 'human-other';
const MCP_TOOL = `mcp__${PICKED}__${CARRY_TOOL}`;
const DONE = 'CHAT_MCP_DONE';

let core: BootedCore;
let live: LiveRoot;
const home = join(tempDir('road-chat-mcp-'), 'core');
const trace = join(home, 'stub-trace.jsonl');
const route = createStubRoute({
  name: 'chat-mcp',
  script: [{ tool: { name: MCP_TOOL, args: { note: 'carried' } } }, DONE],
  trace,
});

beforeAll(async () => {
  if (!present) return;
  core = await bootCore({
    home,
    build: 'road-chat-mcp-live',
    panelAppData: null,
    loop: false,
    routes: createRouteRegistry([route]),
  });
  live = liveRoot('road-chat-mcp-');
  const server = (log: string, tool: string) => ({
    type: 'stdio',
    command: process.execPath,
    args: [PROBE_SERVER],
    env: { PROBE_LOG: log, PROBE_TOOL: tool },
  });
  writeFileSync(
    join(live.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        [PICKED]: server(join(live.root, 'picked.log'), CARRY_TOOL),
        [OTHER]: server(join(live.root, 'other.log'), STRAY_TOOL),
      },
    }),
  );
  // Разрешение инструмента — правилом человека, как в старом чате: вопрос о праве здесь не предмет.
  mkdirSync(join(live.home, '.claude'), { recursive: true });
  writeFileSync(
    join(live.home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: [MCP_TOOL] } }),
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

describe.skipIf(!present)(
  'real Claude chat@1 through the core road with the human MCP servers (s10 p9)',
  () => {
    it('no mcpPicks.chat: both offered servers ride --mcp-config, the journal says «picked by default (chat)», the model calls the picked tool', async () => {
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
      expect(Object.keys(p.spec.mcpServers)).toEqual(expect.arrayContaining([PICKED, OTHER]));
      const note = readJournalLines(join(core.layout.tasks, task.taskId), task.taskId).lines.find(
        (l) => l.kind === 'signal' && (l.data as { signal?: string }).signal === 'mcp-human',
      ) as { data?: { detail?: string } } | undefined;
      expect(note?.data?.detail).toContain(`picked by default (chat): ${OTHER}, ${PICKED}`);

      const launched = await core.road.launch(p);
      if (!launched.ok) throw new Error(launched.reason);
      core.road.started(p, launched.handle, launched.layer);
      const argv = launched.handle.spawned.argv;
      const at = argv.indexOf('--mcp-config');
      expect(at, argv.join(' ')).toBeGreaterThan(-1);
      const mcpArg = argv[at + 1]!;
      const mcpConfig = existsSync(mcpArg) ? readFileSync(mcpArg, 'utf8') : mcpArg;
      expect(Object.keys((JSON.parse(mcpConfig) as { mcpServers: object }).mcpServers)).toEqual(
        expect.arrayContaining([PICKED, OTHER]),
      );
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
        await p.adapter.send(launched.handle, 'call the probe', `cmd-${newId()}`);
        const ended = await until(
          () => events.find((e) => e.type === 'turn.ended'),
          () => `no turn.ended; events ${events.map((e) => e.type).join(',')}`,
        );
        const calls = readProbe(join(live.root, 'picked.log')).filter((e) => e.event === 'call');
        const diag = `ended=${JSON.stringify(ended)} trace=${existsSync(trace) ? readFileSync(trace, 'utf8').slice(-3000) : 'none'}`;
        expect(ended, diag).toMatchObject({ text: DONE });
        expect(calls, diag).toEqual([
          expect.objectContaining({ tool: CARRY_TOOL, args: { note: 'carried' } }),
        ]);
        // Второй сервер тоже поднят CLI (выбран по умолчанию), но не вызывался.
        expect(readProbe(join(live.root, 'other.log')).some((e) => e.event === 'start')).toBe(true);
      } finally {
        await session.end('tree');
      }
    }, 240_000);
  },
);
