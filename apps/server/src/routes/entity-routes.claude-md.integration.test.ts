import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Защита записи CLAUDE.md целиком. Раньше маршрут писал `content ?? ''`, поэтому
 * запрос без поля content ЗАТИРАЛ файл пустой строкой. Различаем «намеренно
 * пустой файл» ('') и «поля content нет / оно не строка»: первое — валидно,
 * второе — отказ без записи.
 */
describe('PUT /api/claude-md: защита от затирания пустотой', () => {
  let root: string;
  let app: FastifyInstance;

  const claudeMdPath = (): string => join(root, 'CLAUDE.md');
  const readMd = (): string => readFileSync(claudeMdPath(), 'utf8');
  const INITIAL = '# Правила\n\nВажный текст, который нельзя потерять.\n';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-claude-md-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    writeFileSync(claudeMdPath(), INITIAL, 'utf8');

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: claudeMdPath(),
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

  const put = (payload: unknown) =>
    app.inject({ method: 'PUT', url: '/api/claude-md', payload: payload as object });

  it('строковый content записывается', async () => {
    const res = await put({ content: '# Новый текст\n' });
    expect(res.statusCode).toBe(200);
    expect(readMd()).toBe('# Новый текст\n');
  });

  it('пустая строка — валидная очистка файла', async () => {
    const res = await put({ content: '' });
    expect(res.statusCode).toBe(200);
    expect(readMd()).toBe('');
  });

  it('запрос без поля content отклоняется 400 и файл не тронут', async () => {
    const res = await put({});
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_content');
    expect(readMd()).toBe(INITIAL);
  });

  it('нестроковый content (число) отклоняется 400 и файл не тронут', async () => {
    const res = await put({ content: 123 });
    expect(res.statusCode).toBe(400);
    expect(readMd()).toBe(INITIAL);
  });

  it('content: null отклоняется 400 и файл не тронут', async () => {
    const res = await put({ content: null });
    expect(res.statusCode).toBe(400);
    expect(readMd()).toBe(INITIAL);
  });
});
