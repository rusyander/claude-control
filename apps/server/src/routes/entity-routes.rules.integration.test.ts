import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Правила по устаревшему id. Id выводится из заголовка при каждом разборе, и у
 * клиента он легко отстаёт от файла (переименование в соседней вкладке,
 * удаление тёзки). Раньше PUT с таким id создавал правило-дубликат, а DELETE
 * молча переписывал файл — с лишней резервной копией и записью в истории.
 * Теперь оба отвечают 404 и файл не трогают.
 */
describe('PUT/DELETE /api/rules/:id с неизвестным id', () => {
  let root: string;
  let app: FastifyInstance;

  const claudeMdPath = (): string => join(root, 'CLAUDE.md');
  const backupDir = (): string => join(root, 'claude-control', 'backups');
  const readMd = (): string => readFileSync(claudeMdPath(), 'utf8');
  const backups = (): string[] => {
    try {
      return readdirSync(backupDir());
    } catch {
      return [];
    }
  };
  const INITIAL = '# Шапка\n\n## ПРАВИЛО: Язык\n\nОтвечать по-русски.\n';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-rules-404-'));
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
      backupDir: backupDir(),
    } as unknown as ServerContext;

    app = Fastify();
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const draft = { title: 'Язык', body: 'Отвечать по-английски.', isEnabled: true, groupIds: [] };

  it('DELETE неизвестного id → 404, файл и копии не тронуты', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/rules/net-takogo' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'rule_not_found' });
    expect(readMd()).toBe(INITIAL);
    expect(backups()).toEqual([]);
  });

  it('PUT неизвестного id → 404, дубликат не создаётся', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/rules/net-takogo', payload: draft });

    expect(res.statusCode).toBe(404);
    expect(readMd()).toBe(INITIAL);
    expect(backups()).toEqual([]);

    const list = await app.inject({ method: 'GET', url: '/api/rules' });
    expect(list.json()).toHaveLength(1);
  });

  it('существующий id по-прежнему правится и удаляется', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/rules/yazyk', payload: draft });
    expect(put.statusCode).toBe(200);
    expect(readMd()).toContain('Отвечать по-английски.');

    const del = await app.inject({ method: 'DELETE', url: '/api/rules/yazyk' });
    expect(del.statusCode).toBe(200);
    expect(readMd()).not.toContain('## ПРАВИЛО:');
  });
});
