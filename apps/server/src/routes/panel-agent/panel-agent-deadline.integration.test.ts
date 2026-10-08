import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  PANEL_ACTION_CONFIRM_TIMEOUT_MS,
  PANEL_AGENT_FIXED_TOOL_TIMEOUT_MS,
  panelAgentConfirmTimeoutMs,
} from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard/origin-guard.ts';
import { resetCliLookupCache } from '../../providers/detect/detect.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending/pending.ts';
import { registerProjectRoutes } from '../project-routes/project-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes/panel-agent-routes.ts';
import { registerPanelAgentRunRoutes } from './run-routes/run-routes.ts';

/**
 * Срок карточки в ходе агента — по CLI (Z-fix 4, 07.10.2026). Карточка Goose
 * обещала 10 минут, а вызов переходника у Goose ждёт 300 с: через пять минут
 * карточку снимал обрыв, и срок в ней был неправдой.
 *
 * Путь настоящий от хода до карточки: маршрут хода, `spawnCliProcess`, argv
 * Goose с `--with-extension`, НАСТОЯЩИЙ переходник `tools/mcp/panel.mjs`,
 * поднятый из этого флага, маршрут действия и реестр карточек. Подменён только
 * сам Goose — фальшивый `goose` на PATH говорит с переходником тем же MCP по
 * stdio, что и настоящий, и отвечает кадрами `stream-json`. Свидетель — срок
 * карточки, которую увидел бы человек (`expiresAt − createdAt`).
 */
const isWindows = process.platform === 'win32';
const ORIGIN = 'http://localhost:8888';

const FAKE_GOOSE = `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(new URL('./dump.json', import.meta.url), JSON.stringify({ argv }));
const spec = argv[argv.indexOf('--with-extension') + 1];
const body = spec.slice(spec.indexOf(':') + 1);
const vars = {};
const words = [];
for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\\\]|\\\\.)*")|("(?:[^"\\\\]|\\\\.)*")/g)) {
  if (match[1]) vars[match[1]] = JSON.parse(match[2]);
  else words.push(JSON.parse(match[3]));
}
// Окружение хода — список панели: свои вводные фальшивый CLI берёт файлом рядом.
const { home, args } = JSON.parse(readFileSync(new URL('./fake-input.json', import.meta.url), 'utf8'));
const bridge = spawn(words[0], words.slice(1), {
  env: { ...process.env, ...vars, USERPROFILE: home, HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map();
createInterface({ input: bridge.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  waiting.get(message.id)?.(message);
});
let next = 0;
const ask = (method, params) => new Promise((done) => {
  next += 1;
  waiting.set(next, done);
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\\n');
});
await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-goose', version: '1' } });
bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
const answer = await ask('tools/call', { name: 'create_project', arguments: args });
bridge.kill();
const text = JSON.stringify(answer.result ?? answer.error ?? null);
process.stdout.write(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'complete' }) + '\\n');
`;

describe('срок карточки в ходе агента — по CLI', () => {
  let root: string;
  let bin: string;
  let home: string;
  let projectDir: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let base: string;
  const savedPath = process.env.PATH;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-deadline-'));
    bin = join(root, 'bin');
    home = join(root, 'home');
    projectDir = join(root, 'project');
    for (const dir of [bin, home, projectDir]) mkdirSync(dir, { recursive: true });
    // Конфиг Goose человека ход читает из APPDATA / дома — оба подменены.
    vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const script = join(bin, 'fake-goose.mjs');
    writeFileSync(script, FAKE_GOOSE, 'utf8');
    writeFileSync(
      join(bin, 'fake-input.json'),
      JSON.stringify({ home, args: { path: projectDir, name: 'Демо' } }),
    );
    if (isWindows) {
      writeFileSync(join(bin, 'goose.cmd'), `@node "%~dp0\\fake-goose.mjs" %*\r\n`);
    } else {
      writeFileSync(
        join(bin, 'goose'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
    }
    const node = join(process.execPath, '..');
    process.env.PATH = isWindows
      ? `${bin}${delimiter}${node}${delimiter}${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`
      : `${bin}${delimiter}${node}${delimiter}/usr/bin${delimiter}/bin`;
    resetCliLookupCache();

    const appData = join(root, 'appdata');
    store = new AppStore(appData);
    // Общий срок — как у панели (`runtime.ts`): ход сокращает его для своего CLI.
    pending = new PanelPendingActions(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: { paths: { appData } },
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    vi.unstubAllEnvs();
    process.env.PATH = savedPath;
    resetCliLookupCache();
    rmSync(root, { recursive: true, force: true });
  });

  // Ход — на своём экземпляре: переходнику нужен адрес панели, известный только
  // после listen, а маршрут хода берёт его при регистрации.
  const startRun = async (): Promise<{ runner: FastifyInstance; done: Promise<string> }> => {
    const runner = Fastify();
    registerPanelAgentRunRoutes(
      runner,
      {
        store,
        location: { paths: { appData: join(root, 'appdata') } },
      } as unknown as ServerContext,
      {
        selfBaseUrl: base,
        gatewayPort: () => 45987,
        pending,
      },
    );
    await runner.ready();
    const done = runner
      .inject({
        method: 'POST',
        url: '/api/agent/run',
        payload: {
          conversationId: 'conv-deadline',
          context: { route: '/projects' },
          messages: [{ role: 'user', content: 'Заведи проект' }],
        },
      })
      .then((response) => response.payload);
    return { runner, done };
  };

  // Ход кончился без карточки — его кадры и есть объяснение, почему.
  const waitCard = async (done: Promise<string>) => {
    let payload: string | undefined;
    void done.then((text) => {
      payload = text;
    });
    for (let i = 0; i < 300 && payload === undefined; i += 1) {
      const [card] = pending.list();
      if (card) return card;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`карточка не появилась: ${payload ?? 'ход ещё идёт'}`);
  };

  it('Goose: карточка хода истекает раньше, чем Goose бросает вызов', async () => {
    store.updateSettings({ provider: 'goose' });
    const { runner, done } = await startRun();
    try {
      const card = await waitCard(done);
      const lifetime = Date.parse(card.expiresAt) - Date.parse(card.createdAt);

      // Срок — из одного места, и он меньше ожидания вызова у самого Goose.
      expect(lifetime).toBe(panelAgentConfirmTimeoutMs('goose'));
      expect(lifetime).toBeLessThan(PANEL_AGENT_FIXED_TOOL_TIMEOUT_MS.goose!);
      expect(lifetime).toBeLessThan(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
      expect(card.conversationId).toBe('conv-deadline');
      // Флаг расширения — тот, из которого переходник и поднят.
      const argv = (JSON.parse(readFileSync(join(bin, 'dump.json'), 'utf8')) as { argv: string[] })
        .argv;
      expect(argv).toContain('--with-extension');

      const decided = await fetch(`${base}/api/agent/pending/${card.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ decision: 'reject' }),
      });
      expect(decided.status).toBe(200);
      await done;
      // Ход закончился — карточки разговора снова на общем сроке.
      const after = pending.create({
        name: 'save_rule',
        risk: 'change',
        conversationId: 'conv-deadline',
        preview: { summary: 'x', fields: [] },
      });
      expect(Date.parse(after.pending.expiresAt) - Date.parse(after.pending.createdAt)).toBe(
        PANEL_ACTION_CONFIRM_TIMEOUT_MS,
      );
      pending.cancel(after.pending.id);
    } finally {
      await runner.close();
    }
    // Отклонено — проект не заведён.
    expect(store.getState().projects ?? []).toEqual([]);
  }, 60_000);

  it('срок по CLI: у задающих ожидание — общий потолок, у Goose — на запас короче 300 с', () => {
    for (const dialect of ['claude', 'qwen', 'codex', 'gemini', 'opencode', 'kimi', undefined]) {
      expect(panelAgentConfirmTimeoutMs(dialect)).toBe(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
    }
    expect(panelAgentConfirmTimeoutMs('goose')).toBe(4 * 60_000);
  });
});
