import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../../lib/empty-body.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { readTcpTable } from '../../../lib/peer-process/peer-process.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { createCoreProxyRoutes } from '../../core-proxy/core-proxy-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';
import { PANEL_ACTIONS } from '../actions.ts';
import { definePanelAction, type AnyPanelAction } from '../registry.ts';

/**
 * Агенты ядра для агента панели (этап 11, W3-19) — настоящим путём модели: переходник
 * `tools/mcp/panel.mjs` по stdio → реестр действий → реестр возможностей → прокладка панели
 * `/api/core/*` → НАСТОЯЩЕЕ ядро одноразового стенда со своим домом. Дерево в журнале задачи
 * записано кодом самого ядра (`tools/qa/core-agents-seed.mjs`: сеанс единицы, субагент «sonnet»,
 * фоновая команда, кончившаяся с кодом 0) — ответ действия сверяется с ним. Выгрузка журнала
 * агентов — файл человеку: действие-нарушитель её просит и получает отказ до прокладки (след
 * обслуженных маршрутов, а не текст ответа).
 */
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const STAND = pathToFileURL(join(REPO, 'tools/qa/throwaway-stand.mjs')).href;
const SEED = join(REPO, 'tools/qa/core-agents-seed.mjs');
const BRIDGE = join(REPO, 'tools/mcp/panel.mjs');
const CONVERSATION = 'conv-w319-agents';
const EXPORT_ROUTE = 'GET /api/core/tasks/:id/agents/export';
/**
 * Форма настоящего id вызова Claude (`toolu_01` + 24 знака; значение выдумано): узел субагента —
 * это id вызова `Agent`. Золотой `toolu_01SubAgent` сетка секретов пропускает, настоящий — нет.
 */
const REAL_CONVERSATION = 'conv-w319-real-ids';
const REAL_TOOL_USE_ID = 'toolu_01Hq7XcPz3RkW9mVbN2tYd4L';

interface Stand {
  coreHome: string;
  stop(): Promise<void>;
}
interface Seeded {
  taskId: string;
  sessionId: string;
  subagent: string;
  background: string;
}
type ToolText = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Row = Record<string, unknown>;

/** Нарушитель: выгрузка журнала агентов задачи — кнопка человека, не действие. */
const ROGUE_EXPORT: AnyPanelAction = definePanelAction({
  name: 'rogue_core_agents_export',
  section: 'test',
  risk: 'read',
  description: 'd',
  input: z.object({ taskId: z.string() }),
  route: (input: { taskId: string }) => ({
    method: 'GET',
    url: `/api/core/tasks/${encodeURIComponent(input.taskId)}/agents/export`,
  }),
} as Parameters<typeof definePanelAction>[0]) as AnyPanelAction;

describe('core_agents of the panel agent against a live core', () => {
  let stand: Stand;
  let seeded: Seeded;
  let realShaped: Seeded;
  let bridgeHome: string;
  let app: FastifyInstance;
  let client: Client;
  const served: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> =>
    (await client.callTool({ name, arguments: args })) as ToolText;

  /** Тело результата «Done.» — JSON после первой строки. */
  const resultOf = (tool: ToolText): Row => {
    const text = tool.content[0]!.text;
    expect(text, text).toMatch(/^Done\./);
    return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Row;
  };
  const byId = (nodes: unknown, id: string): Row | undefined =>
    (nodes as Row[]).find((node) => node.nodeId === id);

  beforeAll(async () => {
    const { startStand } = (await import(STAND)) as {
      startStand(options: object): Promise<Stand>;
    };
    stand = await startStand({
      label: 'core-agents',
      web: false,
      core: true,
      seed: ({ coreHome }: { coreHome: string }) => {
        const seedOne = (...args: string[]): Seeded => {
          const out = execFileSync(
            process.execPath,
            ['--experimental-strip-types', '--no-warnings', SEED, coreHome, ...args],
            { encoding: 'utf8', windowsHide: true },
          );
          return JSON.parse(out.trim().split('\n').pop()!) as Seeded;
        };
        seeded = seedOne(CONVERSATION);
        realShaped = seedOne(REAL_CONVERSATION, 'Агенты с настоящим id', REAL_TOOL_USE_ID);
      },
    });
    bridgeHome = mkdtempSync(join(tmpdir(), 'cc-core-agents-home-'));
    const appData = mkdtempSync(join(tmpdir(), 'cc-core-agents-appdata-'));
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/agent/')) {
        served.push(`${request.method} ${request.routeOptions.url ?? request.url}`);
      }
    });
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    createCoreProxyRoutes({ home: () => stand.coreHome, readTcp: (w) => readTcpTable(w) })(app);
    registerPanelAgentRoutes(
      app,
      { location: { paths: { appData } } } as unknown as ServerContext,
      {
        hub: createEventHub(),
        pending: new PanelPendingActions(60_000),
        access,
        actions: [...PANEL_ACTIONS, ROGUE_EXPORT],
      },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({ name: 'core-agents-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BRIDGE, '--conversation', 'conv-core-agents'],
        // Домашний каталог подменён: токен доступа реальной панели не читается.
        env: {
          AGENTDECK_URL: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
          USERPROFILE: bridgeHome,
          HOME: bridgeHome,
          SystemRoot: process.env.SystemRoot ?? '',
        },
        stderr: 'pipe',
      }),
    );
  }, 240_000);

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await stand?.stop();
    if (bridgeHome) rmSync(bridgeHome, { recursive: true, force: true });
  }, 60_000);

  it('by conversation: the seeded tree — unit session, the sonnet subagent under it, the background command with exit code 0', async () => {
    const result = resultOf(await call('core_agents', { conversationId: CONVERSATION }));
    expect(served).toContain('GET /api/core/agents');
    expect(result).toMatchObject({ conversationId: CONVERSATION, truncated: false });
    const nodes = result.nodes as Row[];
    expect(new Set(nodes.map((node) => node.taskId))).toEqual(new Set([seeded.taskId]));
    expect(byId(nodes, seeded.sessionId)).toMatchObject({ kind: 'unit-session', parentId: null });
    expect(byId(nodes, seeded.subagent)).toMatchObject({
      kind: 'subagent',
      model: 'sonnet',
      parentId: seeded.sessionId,
      status: 'completed',
    });
    expect(byId(nodes, seeded.background)).toMatchObject({
      kind: 'background-shell',
      status: 'completed',
      exitCode: 0,
    });
    // Отрывки поручения и ответа — только в подробностях узла.
    expect(byId(nodes, seeded.subagent)).not.toHaveProperty('briefExcerpt');
  });

  it('a conversation the core does not know has no agents', async () => {
    const result = resultOf(await call('core_agents', { conversationId: 'conv-nobody' }));
    expect(result).toMatchObject({ total: 0, nodes: [] });
  });

  it('by task: the same tree read through the task route', async () => {
    const result = resultOf(await call('core_agents', { taskId: seeded.taskId }));
    expect(served).toContain('GET /api/core/tasks/:id/agents');
    expect(result.taskId).toBe(seeded.taskId);
    const ids = (result.nodes as Row[]).map((node) => node.nodeId);
    expect(ids).toEqual(
      expect.arrayContaining([seeded.sessionId, seeded.subagent, seeded.background]),
    );
  });

  it('one node in detail: the background command, its end and exit code', async () => {
    const result = resultOf(
      await call('core_agents', { taskId: seeded.taskId, nodeId: seeded.background }),
    );
    expect(served).toContain('GET /api/core/tasks/:id/agents/:nodeId');
    expect(result.node).toMatchObject({ nodeId: seeded.background, exitCode: 0 });
    expect(result.background).toEqual([
      expect.objectContaining({ itemId: seeded.background, how: 'exit', exitCode: 0 }),
    ]);
  });

  /**
   * Ревью W3-19 F-01: id узла субагента — id вызова CLI; сетка секретов перед моделью прятала его
   * («••••••») вместе с `parentId` его детей — модель не могла ни спросить узел подробно, ни
   * собрать дерево. Id узла — не секрет: его пишет CLI, а не человек.
   */
  it('a real-shaped Claude tool-use id reaches the model: the subagent node and its detail', async () => {
    const list = resultOf(await call('core_agents', { conversationId: REAL_CONVERSATION }));
    const nodes = list.nodes as Row[];
    expect(byId(nodes, REAL_TOOL_USE_ID)).toMatchObject({
      kind: 'subagent',
      parentId: realShaped.sessionId,
    });
    const detail = resultOf(
      await call('core_agents', { taskId: realShaped.taskId, nodeId: REAL_TOOL_USE_ID }),
    );
    expect(detail.node).toMatchObject({ nodeId: REAL_TOOL_USE_ID, model: 'sonnet' });
  });

  /**
   * Вход модели не уводит действие на соседнюю ручку (ревью W3-19, проход 8): узел кладётся в
   * сегмент адреса, а у `…/agents/:nodeId` есть статичные соседи — выгрузка (человеку) и поток
   * (окну); `encodeURIComponent('..')` — это `..`. Такие узлы отказывает реестр возможностей до
   * прокладки; прочие уходят ядру одним сегментом и получают «узла нет».
   */
  it('crafted node ids never reach the export, the stream or a parent path', async () => {
    const refusedBeforeProxy = ['export', 'stream', '..', '.'];
    for (const nodeId of refusedBeforeProxy) {
      const before = served.length;
      const tool = await call('core_agents', { taskId: seeded.taskId, nodeId });
      expect(served.slice(before), nodeId).toEqual([]);
      expect(tool.isError, nodeId).toBe(true);
      expect(tool.content[0]!.text, nodeId).toContain('Nothing was executed.');
    }
    const oneSegment = [
      '%2e%2e',
      'a/../../export',
      '..%2Fexport',
      'export?x=1',
      'export#x',
      '..\\export',
    ];
    for (const nodeId of oneSegment) {
      const before = served.length;
      const tool = await call('core_agents', { taskId: seeded.taskId, nodeId });
      expect(new Set(served.slice(before)), nodeId).toEqual(
        new Set(['GET /api/core/tasks/:id/agents/:nodeId']),
      );
      expect(tool.isError, nodeId).toBe(true);
    }
    expect(served).not.toContain(EXPORT_ROUTE);
    expect(served).not.toContain('GET /api/core/tasks/:id/agents/stream');
  });

  it('the conversation id stays one query value: no extra filter, no cut by #', async () => {
    for (const conversationId of [`${CONVERSATION}&kind=subagent`, `${CONVERSATION}#x`]) {
      const result = resultOf(await call('core_agents', { conversationId }));
      // Склеенный фильтр дал бы одного субагента, обрезка по `#` — всё дерево разговора.
      expect(result, conversationId).toMatchObject({ conversationId, total: 0, nodes: [] });
    }
    const tool = await call('core_agents', { taskId: '../agents', nodeId: 'x' });
    expect(tool.isError).toBe(true);
  });

  it('the agents export is the human’s file: refused before the proxy', async () => {
    const tool = await call('rogue_core_agents_export', { taskId: seeded.taskId });
    expect(served).not.toContain(EXPORT_ROUTE);
    expect(tool.isError).toBe(true);
    expect(tool.content[0]!.text).toMatch(/human’s \(GET core\/tasks\/:id\/agents\/export\)/);
    expect(tool.content[0]!.text).toContain('Nothing was executed.');
  });
});
