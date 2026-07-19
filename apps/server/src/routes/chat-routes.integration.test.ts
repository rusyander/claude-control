import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatRoutes } from './chat-routes.ts';

/**
 * Интеграционные тесты маршрутов проектов и файловой системы: реальный Fastify,
 * реальные домены, временные каталоги вместо настоящего ~/.claude. Проверяем
 * склейку маршрут↔домен↔сериализация через inject. `open-in-editor` — только
 * валидацию: успех реально запустил бы редактор. Тест-кейсы см.
 * .agent/TEST-CASES.md → «Маршруты проектов/ФС (интеграция)».
 */
describe('маршруты чата: проекты и ФС', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-routes-'));
    mkdirSync(join(root, 'projects', 'enc-a'), { recursive: true });
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    // Транскрипт настоящего проекта — cwd указывает на существующий каталог.
    const realProject = mkdtempSync(join(tmpdir(), 'cc-realproj-'));
    writeFileSync(
      join(root, 'projects', 'enc-a', 'sess.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-18T10:00:00.000Z',
        cwd: realProject,
        message: { role: 'user', content: 'привет' },
      }) + '\n',
    );

    const ctx = {
      location: { paths: { root } },
      store: new AppStore(join(root, 'claude-control')),
    } as unknown as ServerContext;

    app = Fastify();
    registerChatRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/chats/projects возвращает проект из истории', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats/projects' });
    expect(res.statusCode).toBe(200);
    const projects = res.json() as Array<{ path: string; exists: boolean; chats: unknown[] }>;
    expect(projects.length).toBe(1);
    expect(projects[0]?.exists).toBe(true);
    expect(projects[0]?.chats.length).toBe(1);
  });

  it('GET /api/fs/roots содержит домашнюю папку', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/roots' });
    expect(res.statusCode).toBe(200);
    const roots = res.json() as Array<{ name: string }>;
    expect(roots.some((entry) => entry.name === '~')).toBe(true);
  });

  it('GET /api/fs/list по каталогу отдаёт подпапки', async () => {
    mkdirSync(join(root, 'sub-x'));
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(root)}`,
    });
    expect(res.statusCode).toBe(200);
    const listing = res.json() as { entries: Array<{ name: string }> };
    expect(listing.entries.some((entry) => entry.name === 'sub-x')).toBe(true);
  });

  it('GET /api/fs/list без пути → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list' });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/editors перечисляет редакторы с флагом available', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/editors' });
    expect(res.statusCode).toBe(200);
    const editors = res.json() as Array<{ command: string; available: boolean }>;
    expect(editors.some((editor) => editor.command === 'code')).toBe(true);
  });

  it('POST /api/projects/open-in-editor с несуществующим путём → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open-in-editor',
      payload: { path: 'C:/nope/gone-xyz' },
    });
    expect(res.statusCode).toBe(400);
  });
});
