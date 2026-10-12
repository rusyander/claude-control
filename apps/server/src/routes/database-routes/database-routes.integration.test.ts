import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DbConnectionsInfo } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { DockerExec } from '../../domains/compose/compose.ts';
import { registerDatabaseRoutes } from './database-routes.ts';

/**
 * Маршруты базы на уровне HTTP: граница «свой проект», поиск подключений через
 * разбор настоящего ответа `compose config`, сторож до соединения, ошибка
 * соединения с настоящим сокетом (порт, на котором никто не слушает), свои
 * подключения без утечки пароля, запись переходника MCP во временный конфиг.
 * Подменена только программа docker. Настоящий Postgres гоняет
 * `tools/qa/check-database.mjs`.
 */

/** Порт, где наверняка никого: соединение откажет сразу, без таймаута. */
const DEAD_PORT = 1;

const CONFIG = JSON.stringify({
  name: 'shop',
  services: {
    db: {
      image: 'postgres:18',
      ports: [
        {
          mode: 'ingress',
          host_ip: '127.0.0.1',
          target: 5432,
          published: String(DEAD_PORT),
          protocol: 'tcp',
        },
      ],
      environment: {
        POSTGRES_USER: 'shop',
        POSTGRES_PASSWORD: 'compose-secret',
        POSTGRES_DB: 'shop',
      },
    },
    cache: { image: 'mysql:8', environment: {} },
  },
});

describe('база данных: маршруты', () => {
  let app: FastifyInstance;
  let root: string;
  let project: string;
  let stranger: string;
  let appData: string;
  let mcpConfig: string;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-db-routes-')));
    project = join(root, 'shop');
    stranger = join(root, 'other');
    appData = join(root, 'agentdeck');
    mcpConfig = join(root, 'claude.json');
    for (const dir of [project, stranger]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'compose.yaml'), 'services: {}');
    }
    writeFileSync(
      join(project, '.env'),
      'READ_DATABASE_URL=postgres://ro:env-secret@db.stage.example.com/shop\n',
    );
    writeFileSync(mcpConfig, '{}\n');
    const store = new AppStore(appData);
    store.addProject({ id: 'shop', name: 'shop', path: project });

    const exec: DockerExec = async (args) => {
      if (args[0] === 'info') return { code: 0, stdout: '29.7.2', stderr: '' };
      if (args[1] === 'config') return { code: 0, stdout: CONFIG, stderr: '' };
      if (args[1] === 'ps') {
        return {
          code: 0,
          stdout: JSON.stringify({ Service: 'db', State: 'running', Publishers: [] }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const ctx = {
      store,
      backupDir: undefined,
      location: { paths: { appData, mcpConfig } },
    } as unknown as ServerContext;
    app = Fastify();
    registerDatabaseRoutes(app, ctx, { exec, selfBaseUrl: 'http://127.0.0.1:5999' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const connections = async (path: string) =>
    app.inject({
      method: 'GET',
      url: `/api/database/connections?path=${encodeURIComponent(path)}`,
    });

  it('подключения проекта: compose, .env и чужой движок; паролей в ответе нет', async () => {
    const response = await connections(project);
    expect(response.statusCode).toBe(200);
    const info = response.json<DbConnectionsInfo>();
    expect(
      info.connections.map((item) => [item.id, item.host, item.remote, item.hasPassword]),
    ).toEqual([
      ['compose:db', '127.0.0.1', false, true],
      ['env:.env:READ_DATABASE_URL', 'db.stage.example.com', true, true],
    ]);
    expect(info.connections[0]).toMatchObject({ composeService: 'db', composeState: 'running' });
    expect(info.unsupported).toEqual([
      { origin: 'compose.yaml → cache', engine: 'mysql', reason: 'engine' },
    ]);
    expect(info.mcpRegistered).toBe(false);
    expect(response.body).not.toContain('secret');
  });

  it('чужой каталог и относительный путь — отказ до чтения файлов', async () => {
    expect((await connections(stranger)).json()).toMatchObject({ code: 'db-project-unregistered' });
    expect((await connections('shop')).json()).toMatchObject({ code: 'db-path-required' });
  });

  const query = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/database/query',
      payload: { path: project, ...payload },
    });

  it('запись отказывается сторожем ещё до соединения', async () => {
    const response = await query({ connectionId: 'compose:db', sql: 'delete from users' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'db-sql-refused',
      refusal: { reason: 'not-read', word: 'delete' },
    });
  });

  it('неизвестное подключение — 404 со списком; недоступная база — 502 «connect»', async () => {
    const unknown = await query({ connectionId: 'compose:nope', sql: 'select 1' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'db-connection-unknown' });

    const dead = await query({ connectionId: 'compose:db', sql: 'select 1' });
    expect(dead.statusCode).toBe(502);
    expect(dead.json()).toMatchObject({ code: 'db-error', kind: 'connect' });
  });

  it('своё подключение: заводится, правится без пароля, убирается; пароль не уходит наружу', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/database/connections',
      payload: {
        path: project,
        label: 'Отчёты',
        host: 'reports.example.com',
        port: 5432,
        database: 'reports',
        user: 'ro',
        password: 'manual-secret',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('manual-secret');
    const savedId = saved.json<{ savedId: string }>().savedId;
    expect(saved.json<DbConnectionsInfo>().connections.at(-1)).toMatchObject({
      id: savedId,
      source: 'manual',
      hasPassword: true,
      remote: true,
    });
    for (const name of readdirSync(appData)) {
      expect(readFileSync(join(appData, name), 'utf8')).not.toContain('manual-secret');
    }

    const foundOne = await app.inject({
      method: 'POST',
      url: '/api/database/connections/remove',
      payload: { path: project, id: 'compose:db' },
    });
    expect(foundOne.json()).toMatchObject({ code: 'db-connection-not-manual' });

    const removed = await app.inject({
      method: 'POST',
      url: '/api/database/connections/remove',
      payload: { path: project, id: savedId },
    });
    expect(removed.json<DbConnectionsInfo>().connections.map((item) => item.id)).not.toContain(
      savedId,
    );
  });

  it('миграции без подключения — только файлы проекта', async () => {
    mkdirSync(join(project, 'migrations'));
    writeFileSync(join(project, 'migrations', '000001_init.up.sql'), 'create table a();');
    const response = await app.inject({
      method: 'GET',
      url: `/api/database/migrations?path=${encodeURIComponent(project)}`,
    });
    expect(response.json()).toEqual({
      tool: 'golang-migrate',
      dir: 'migrations',
      table: 'schema_migrations',
      migrations: [{ id: '000001', applied: false }],
      orphaned: [],
    });
  });

  it('переходник MCP: запись несёт только адрес панели и снимается', async () => {
    const on = await app.inject({
      method: 'POST',
      url: '/api/database/mcp',
      payload: { enabled: true },
    });
    expect(on.json()).toMatchObject({ connected: true });
    const written = readFileSync(mcpConfig, 'utf8');
    expect(written).toContain('database.mjs');
    expect(written).toContain('http://127.0.0.1:5999');
    expect(written).not.toContain('secret');
    expect((await connections(project)).json<DbConnectionsInfo>().mcpRegistered).toBe(true);

    await app.inject({ method: 'POST', url: '/api/database/mcp', payload: { enabled: false } });
    expect((await connections(project)).json<DbConnectionsInfo>().mcpRegistered).toBe(false);
  });
});
