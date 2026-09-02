import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppSettings } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerConfigRoutes } from './config-routes.ts';

/**
 * Смена каталога через PATCH /api/settings и ручной доступ — аудит «Настройки»
 * 2026-09-03. Раньше PATCH с несуществующим каталогом отвечал 200: настройки
 * называли один каталог, /api/location — другой; `{value: 123}` в доступе
 * роняло `.trim()` пятисоткой.
 */
describe('config-routes: каталог через настройки и ручной доступ', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let relocated: string[];
  let remembered: string[];

  const getSettings = async (): Promise<AppSettings> =>
    (await app.inject({ method: 'GET', url: '/api/settings' })).json<AppSettings>();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-config-dir-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    store = new AppStore(join(root, 'claude-control'));
    relocated = [];
    remembered = [];

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
          appData: join(root, 'claude-control'),
        },
      },
      store,
      backupDir: join(root, 'claude-control', 'backups'),
      applyIoSettings: () => {},
      // Настоящий relocate не нужен: важно, что маршрут смотрит на его вердикт.
      relocate: (path: string) => {
        relocated.push(path);
        return path.includes('missing')
          ? { isValid: false, problem: 'Каталог не существует: ' + path }
          : { isValid: true };
      },
      rememberDirOverride: (value: string) => {
        remembered.push(value);
      },
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;

    app = Fastify();
    registerConfigRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('невалидный каталог → 400 invalid_path, ничего не записано и не запомнено', async () => {
    const before = await getSettings();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { claudeDirOverride: 'C:/missing/.claude', theme: 'dark' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_path' });
    expect(res.json<{ message: string }>().message).toContain('missing');
    expect(relocated).toEqual(['C:/missing/.claude']);
    expect(remembered).toEqual([]);
    // Сопутствующее поле тоже не осело: запрос отклонён целиком.
    expect((await getSettings()).theme).toBe(before.theme);
  });

  it('валидный каталог переезжает и запоминается через контекст, не через store', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { claudeDirOverride: 'C:/other/.claude' },
    });
    expect(res.statusCode).toBe(200);
    expect(relocated).toEqual(['C:/other/.claude']);
    expect(remembered).toEqual(['C:/other/.claude']);
    // Память о пути — забота контекста (хранилище каталога старта), в текущий
    // store маршрут её не пишет.
    expect(store.getSettings().claudeDirOverride).toBe('');
  });

  it('пустая строка — возврат к автоопределению, всегда принимается', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { claudeDirOverride: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(relocated).toEqual(['']);
    expect(remembered).toEqual(['']);
  });

  it('POST /api/credentials не строкой → 400, не 500', async () => {
    for (const value of [123, { a: 1 }, null, undefined]) {
      const res = await app.inject({ method: 'POST', url: '/api/credentials', payload: { value } });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBeTruthy();
    }
  });
});
