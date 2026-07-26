import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../context.ts';
import { registerResourceRoutes } from './resource-routes.ts';

/**
 * Имя файла — обязательный параметр запроса, а не «как получится».
 *
 * Без `?file=` оно доезжало до `safePath`, где сразу тримится: чтение отвечало
 * 500 с внутренним «Cannot read properties of undefined», удаление — 400 с тем
 * же текстом. И то и другое читается как поломка сервера, хотя это обычный
 * некорректный запрос.
 */
describe('resource-routes: файл в запросе не указан', () => {
  let root: string;
  let app: FastifyInstance;

  const skillFile = (): string => join(root, 'skills', 'demo', 'SKILL.md');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-resource-routes-'));
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    writeFileSync(skillFile(), '---\nname: demo\ndescription: x\n---\n\nтело\n');

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          appData: join(root, 'claude-control'),
        },
      },
      backupDir: join(root, 'claude-control', 'backups'),
      store: {},
    } as unknown as ServerContext;

    app = Fastify();
    registerResourceRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET без ?file= — 400 «не указан файл», а не 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/resources/skill/demo/file' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe('Не указан файл');
  });

  it('DELETE без ?file= — 400 с человеческой причиной, и ничего не удалено', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/resources/skill/demo/file' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe('Не указан файл');
    expect(existsSync(skillFile())).toBe(true);
  });

  it('PUT без имени файла — 400, содержимое ресурса не тронуто', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/resources/skill/demo/file',
      payload: { content: 'подмена' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe('Не указан файл');
  });

  it('с именем файла чтение работает как прежде', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/resources/skill/demo/file?file=SKILL.md',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ content: string }>().content).toContain('тело');
  });
});
