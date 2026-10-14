import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalMcpInfo, LocalServerInfo } from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../../context.ts';
import type { KitService } from '../../domains/kit/service.ts';
import { createLocalModels } from '../../domains/local-models/service.ts';
import { localPaths, readState } from '../../domains/local-models/paths.ts';
import type { LocalMcpSource, McpSourceEntry } from '../../domains/local-models/local-mcp.ts';
import { registerLocalModelsRoutes } from './local-models-routes.ts';

/**
 * MCP локального прогона и «держать загруженной» поверх настоящих маршрутов и
 * сервиса. Подменён только источник MCP-серверов (файлы настроек и чужие процессы —
 * внешняя граница): сервер моделей не запущен, цена идёт прикидкой.
 */

const entry = (id: string): McpSourceEntry => ({
  id,
  scope: 'user',
  transport: 'stdio',
  config: { command: id },
  server: {
    id,
    name: id,
    transport: 'stdio',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
  },
});

const source: LocalMcpSource = {
  list: () => [entry('gitlab'), entry('figma')],
  tools: async () => [{ name: 'list', description: 'List things' }],
};

let root: string;
let project: string;
let app: FastifyInstance;
let env: NodeJS.ProcessEnv;

async function call<T>(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json() as T };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-mcp-routes-'));
  project = join(root, 'project');
  mkdirSync(project);
  env = { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') };
  const local = createLocalModels({ appRoot: root, env, port: 11_496, mcp: source });
  app = Fastify();
  registerLocalModelsRoutes(app, {} as ServerContext, local, {} as KitService);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET/PUT/POST /api/local-models/mcp', () => {
  it('серверы проекта без выбора: ни один не взят, цены нет, запас — вся основа', async () => {
    const { status, body } = await call<LocalMcpInfo>(
      'GET',
      `/api/local-models/mcp?project=${encodeURIComponent(project)}`,
    );
    expect(status).toBe(200);
    expect(body.servers.map((server) => [server.id, server.picked, server.tokens])).toEqual([
      ['gitlab', false, null],
      ['figma', false, null],
    ]);
    expect(body.picked).toEqual([]);
    expect(body.headroom).toBe(body.compactAt - body.baseTokens);
  });

  it('замер даёт цену, выбор запоминается и уменьшает запас', async () => {
    const measured = await call<LocalMcpInfo>('POST', '/api/local-models/mcp/measure', { project });
    expect(measured.status).toBe(200);
    const gitlab = measured.body.servers.find((server) => server.id === 'gitlab');
    expect(gitlab?.tokens).toBeGreaterThan(0);
    expect(gitlab?.source).toBe('estimate');

    const picked = await call<LocalMcpInfo>('PUT', '/api/local-models/mcp', {
      project,
      servers: ['gitlab'],
    });
    expect(picked.body.picked).toEqual(['gitlab']);
    expect(picked.body.headroom).toBe(
      picked.body.compactAt - picked.body.baseTokens - (gitlab?.tokens ?? 0),
    );
    // Тот же выбор читается отдельным запросом, и он лежит в состоянии раздела.
    const again = await call<LocalMcpInfo>(
      'GET',
      `/api/local-models/mcp?project=${encodeURIComponent(project)}`,
    );
    expect(again.body.picked).toEqual(['gitlab']);
    expect(Object.values(readState(localPaths(root, env)).mcpPicks)).toEqual([['gitlab']]);
  });

  it('проект не назван, не абсолютный или не каталог — 400 с кодом, а не чтение чего придётся', async () => {
    const file = join(root, 'file.txt');
    writeFileSync(file, 'x');
    for (const url of [
      '/api/local-models/mcp',
      '/api/local-models/mcp?project=relative/dir',
      `/api/local-models/mcp?project=${encodeURIComponent(file)}`,
      `/api/local-models/mcp?project=${encodeURIComponent(join(root, 'нет-такого'))}`,
    ]) {
      const { status, body } = await call<{ messageCode?: string }>('GET', url);
      expect(status, url).toBe(400);
      expect(body.messageCode, url).toBe('local-mcp-project');
    }
    const put = await call('PUT', '/api/local-models/mcp', { project: 'relative', servers: [] });
    expect(put.status).toBe(400);
    const bad = await call('PUT', '/api/local-models/mcp', { servers: [] });
    expect(bad.status).toBe(400);
  });
});

describe('PUT /api/local-models/keep-loaded', () => {
  it('настройка запоминается и показывается на карточке сервера', async () => {
    const on = await call<LocalServerInfo>('PUT', '/api/local-models/keep-loaded', {
      keepLoaded: true,
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ keepLoaded: true, idleSeconds: 600 });
    expect(readState(localPaths(root, env)).keepLoaded).toBe(true);
    const off = await call<LocalServerInfo>('PUT', '/api/local-models/keep-loaded', {
      keepLoaded: false,
    });
    expect(off.body).toMatchObject({ keepLoaded: false, idleSeconds: 600 });
  });

  it('тело не того вида — 400', async () => {
    expect((await call('PUT', '/api/local-models/keep-loaded', { keepLoaded: 'yes' })).status).toBe(
      400,
    );
  });
});
