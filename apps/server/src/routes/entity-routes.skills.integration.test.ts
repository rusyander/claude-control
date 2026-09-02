import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Id скилла из адреса шёл в join() как есть. `PUT /api/skills/..` создавал
 * SKILL.md в корне каталога конфигурации, `DELETE /api/skills/..` снёс бы его
 * целиком. Проверяем все четыре входа (правка, удаление, выключение,
 * переименование): 400 и ни одного изменения на диске, включая папку копий.
 */
describe('/api/skills с id вне skills/', () => {
  let root: string;
  let app: FastifyInstance;

  const backups = (): string[] => {
    try {
      return readdirSync(join(root, 'claude-control', 'backups'));
    } catch {
      return [];
    }
  };
  const snapshot = (): string[] =>
    (readdirSync(root, { recursive: true }) as string[]).map((p) => p.replace(/\\/g, '/')).sort();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-skills-400-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    mkdirSync(join(root, 'skills', 'good'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'good', 'SKILL.md'),
      '---\nname: good\ndescription: d\n---\n\nbody\n',
    );
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'keep.txt'), 'x');

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
        },
      },
      store: new AppStore(join(root, 'claude-control')),
      backupDir: join(root, 'claude-control', 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const draft = { name: 'x', description: 'y', body: 'z', groupIds: [] };

  // Голый `..` тестовый inject схлопывает ещё в адресе (404), а живой HTTP с
  // `--path-as-is` доносит до обработчика — этот случай закрывает доменный
  // тест (`skills.safety.test.ts`). Здесь — закодированный слэш: он проходит
  // роутер как один сегмент и раскрывается уже в параметре.
  const BAD = ['..%2Fhooks', '..%2F..'];

  it.each(BAD)('PUT /api/skills/%s → 400, ничего не записано', async (id) => {
    const before = snapshot();
    const res = await app.inject({ method: 'PUT', url: `/api/skills/${id}`, payload: draft });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_id' });
    expect(existsSync(join(root, 'SKILL.md'))).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it.each(BAD)(
    'DELETE /api/skills/%s → 400, каталог и копии не тронуты',
    async (id) => {
      const before = snapshot();
      const res = await app.inject({ method: 'DELETE', url: `/api/skills/${id}` });

      expect(res.statusCode).toBe(400);
      expect(existsSync(join(root, 'hooks', 'keep.txt'))).toBe(true);
      expect(backups()).toEqual([]);
      expect(snapshot()).toEqual(before);
    },
  );

  it.each(BAD)('POST /api/entities/skill/%s/enabled → 400, отметки нет', async (id) => {
    const before = snapshot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/entities/skill/${id}/enabled`,
      payload: { isEnabled: false },
    });

    expect(res.statusCode).toBe(400);
    // Отметка ставится до применения — без ранней проверки state.json получал
    // запись о несуществующем скилле с опасным id.
    expect(existsSync(join(root, 'claude-control', 'state.json'))).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('POST /api/skills/..%2Fhooks/rename → 400', async () => {
    const before = snapshot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/..%2Fhooks/rename',
      payload: { newId: 'novyi' },
    });

    expect(res.statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it('обычный id работает как раньше', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/skills/good', payload: draft });
    expect(put.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: '/api/skills/good' });
    expect(del.statusCode).toBe(200);
    expect(existsSync(join(root, 'skills', 'good'))).toBe(false);
    expect(backups().length).toBeGreaterThan(0);
  });
});
