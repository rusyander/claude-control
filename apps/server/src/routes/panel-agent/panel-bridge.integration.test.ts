import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Project } from '@agentdeck/contracts';
import {
  PANEL_ACTION_CONFIRM_TIMEOUT_MS,
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_HEADER,
} from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { agentJournalPath } from '../../domains/panel-agent/journal.ts';
import { panelBridgeScript } from '../../domains/panel-agent/runner.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';
import { textWindow } from './action-kit.ts';

/**
 * Переходник `tools/mcp/panel.mjs` (А2) — настоящим процессом по stdio против
 * панели на своём порту: клиент MCP из того же SDK, реестр, карточка и маршрут
 * проектов настоящие. Решение по карточке — HTTP-запросом с Origin окна, как
 * кликает человек. Доказательство — реестр проектов, а не текст инструмента.
 */
const ORIGIN = 'http://localhost:8888';

type ToolText = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('tools/mcp/panel.mjs', () => {
  let appData: string;
  let home: string;
  let projectDir: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let base: string;
  let client: Client;
  const seenHeaders: Array<string | string[] | undefined> = [];

  const connect = async (url: string, extra: Record<string, string> = {}): Promise<Client> => {
    const next = new Client({ name: 'bridge-test', version: '1.0.0' });
    await next.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [panelBridgeScript(), '--conversation', 'conv-bridge'],
        // Домашний каталог подменён: токен доступа реальной панели не читается.
        env: {
          AGENTDECK_URL: url,
          USERPROFILE: home,
          HOME: home,
          SystemRoot: process.env.SystemRoot ?? '',
          ...extra,
        },
        stderr: 'pipe',
      }),
    );
    return next;
  };

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-bridge-appdata-'));
    home = mkdtempSync(join(tmpdir(), 'cc-bridge-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-bridge-project-'));
    store = new AppStore(appData);
    pending = new PanelPendingActions(60_000);
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
    app.addHook('onRequest', async (request) => {
      if (request.url.startsWith('/api/agent/actions')) {
        seenHeaders.push(request.headers[PANEL_AGENT_HEADER]);
      }
    });
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    client = await connect(base);
  });

  afterEach(async () => {
    await client.close();
    pending.cancelAll();
    await app.close();
    for (const dir of [appData, home, projectDir]) rmSync(dir, { recursive: true, force: true });
  });

  const waitPending = async (): Promise<string> => {
    for (let i = 0; i < 100; i += 1) {
      const [card] = pending.list();
      if (card) return card.id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('карточка не появилась');
  };

  const decide = (id: string, decision: 'approve' | 'reject') =>
    fetch(`${base}/api/agent/pending/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ decision }),
    });

  const projects = (): Project[] => store.getState().projects ?? [];

  it('инструменты — реестр панели как есть, JSON Schema входа без пересборки', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['where_am_i', 'list_sections', 'open_page', 'create_project']),
    );
    const create = tools.find((tool) => tool.name === 'create_project')!;
    expect(create.description).toMatch(/^\[change\] /);
    expect(create.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    });
  });

  it('list_sections — настоящий ответ, запрос помечен заголовком агента', async () => {
    const result = (await client.callTool({ name: 'list_sections', arguments: {} })) as ToolText;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/^Done\./);
    expect(result.content[0]!.text).toContain('"/projects"');
    expect(seenHeaders.length).toBeGreaterThan(0);
    expect(seenHeaders.every((value) => value === '1')).toBe(true);

    const journal = readFileSync(agentJournalPath(appData), 'utf8');
    expect(journal).toContain('"name":"list_sections"');
    expect(journal).toContain('"conversationId":"conv-bridge"');
  });

  it('create_project: карточка ждёт; отклонено — проекта нет, модель слышит «rejected»', async () => {
    const call = client.callTool({
      name: 'create_project',
      arguments: { path: projectDir, name: 'Демо' },
    }) as Promise<ToolText>;
    const id = await waitPending();
    expect(projects()).toHaveLength(0);
    expect((await decide(id, 'reject')).status).toBe(200);

    const result = await call;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('REJECTED');
    expect(projects()).toHaveLength(0);
  });

  it('create_project: подтверждено кликом — проект в реестре', async () => {
    const call = client.callTool({
      name: 'create_project',
      arguments: { path: projectDir, name: 'Демо' },
    }) as Promise<ToolText>;
    const id = await waitPending();
    expect((await decide(id, 'approve')).status).toBe(200);
    const result = await call;
    expect(result.content[0]!.text).toMatch(/^Done\. The panel opened \/projects/);
    expect(projects().map((project) => project.name)).toEqual(['Демо']);
  });

  it('агент не решает сам: решение с заголовком переходника — 403, карточка ждёт', async () => {
    const call = client.callTool({
      name: 'create_project',
      arguments: { path: projectDir },
    }) as Promise<ToolText>;
    const id = await waitPending();
    const forged = await fetch(`${base}/api/agent/pending/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [PANEL_AGENT_HEADER]: '1' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(forged.status).toBe(403);
    expect(pending.list()).toHaveLength(1);
    await decide(id, 'reject');
    await call;
    expect(projects()).toHaveLength(0);
  });

  it('неверный вход и мёртвая панель — предложение, а не исключение', async () => {
    const invalid = (await client.callTool({
      name: 'create_project',
      arguments: { path: '' },
    })) as ToolText;
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toContain('Input rejected');

    const dead = await connect('http://127.0.0.1:9');
    try {
      const { tools } = await dead.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['panel_unavailable']);
      const result = (await dead.callTool({ name: 'list_sections', arguments: {} })) as ToolText;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('unreachable');
    } finally {
      await dead.close();
    }
  });

  /**
   * Заглушка панели: исходы, которые настоящий реестр даёт только через долгий
   * клик или внешний сервис. Переходник — настоящий процесс, как у модели.
   */
  const stubPanel = async (): Promise<{ url: string; server: Server }> => {
    const tool = (name: string) => ({
      name,
      risk: 'read',
      description: name,
      inputSchema: { type: 'object', properties: {} },
    });
    const big = `${'"\
'.repeat(10_000)}конец`;
    const server = createServer((request, response) => {
      const send = (body: unknown) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(body));
      };
      if (request.method === 'GET') return send({ actions: ['slow', 'secret', 'big'].map(tool) });
      if (request.url?.endsWith('/slow')) return; // взял запрос и молчит — как поздно одобренное
      if (request.url?.endsWith('/secret')) {
        return send({
          outcome: 'needs-secret',
          page: { route: '/contour' },
          message: 'Then read contour_status.',
          result: { id: 'draft-7', field: 'apiKey' },
        });
      }
      send({ outcome: 'done', result: textWindow(big) });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  };

  it('таймаут после взятого запроса — «исход неизвестен», а не «панель не запущена»', async () => {
    const stub = await stubPanel();
    const bridge = await connect(stub.url, { AGENTDECK_BRIDGE_CALL_TIMEOUT_MS: '1500' });
    try {
      const result = (await bridge.callTool({ name: 'slow', arguments: {} })) as ToolText;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('UNKNOWN');
      expect(result.content[0]!.text).not.toContain('Nothing was done');
    } finally {
      await bridge.close();
      stub.server.closeAllConnections();
      await new Promise((done) => stub.server.close(done));
    }
    // Панели нет вовсе: отказ в соединении — вот тут «ничего не сделано» правда. Не
    // освобождённый порт заглушки: в полном прогоне его успевал занять сервер
    // соседнего теста, и вместо отказа приходил его 404. На порту 1 не слушает никто.
    const closed = await connect('http://127.0.0.1:1');
    try {
      const result = (await closed.callTool({ name: 'slow', arguments: {} })) as ToolText;
      expect(result.content[0]!.text).toContain('Nothing was done');
    } finally {
      await closed.close();
    }
  });

  it('нужен секрет — модель получает проекцию и сообщение панели; большое окно не теряет nextOffset', async () => {
    const stub = await stubPanel();
    const bridge = await connect(stub.url);
    try {
      const secret = (await bridge.callTool({ name: 'secret', arguments: {} })) as ToolText;
      expect(secret.content[0]!.text).toContain('draft-7');
      expect(secret.content[0]!.text).toContain('Then read contour_status.');

      const read = (await bridge.callTool({ name: 'big', arguments: {} })) as ToolText;
      const text = read.content[0]!.text;
      expect(text).not.toContain('(truncated');
      const window = JSON.parse(text.slice(text.indexOf('{'))) as {
        nextOffset?: number;
        text: string;
      };
      expect(window.nextOffset).toBe(window.text.length);
      expect(window.nextOffset).toBeLessThan(30_000);
    } finally {
      await bridge.close();
      stub.server.close();
    }
  });

  it('константы переходника совпадают с контрактом', () => {
    const source = readFileSync(panelBridgeScript(), 'utf8');
    expect(source).toContain(`const PANEL_AGENT_HEADER = '${PANEL_AGENT_HEADER}';`);
    expect(source).toContain(`name: '${PANEL_AGENT_BRIDGE_ID}'`);
    const confirm = /const PANEL_ACTION_CONFIRM_TIMEOUT_MS = (\d+) \* 60_000;/.exec(source);
    expect(Number(confirm?.[1]) * 60_000).toBe(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
  });
});
