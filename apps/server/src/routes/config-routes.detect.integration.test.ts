import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderDetectResponse } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerConfigRoutes } from './config-routes.ts';

/**
 * `GET /api/providers/detect` (Ф7) — детект установленных провайдер-CLI.
 *
 * Роут читающий и безопасный: только `where`/`which` + `existsSync`, ничего не
 * пишет и не спавнит `--version`. Поэтому проверяем его на живом Fastify как
 * есть, с настоящим детектом: результат зависит от машины, но ФОРМА ответа и
 * инварианты (200, все провайдеры, никакой версии) — нет.
 *
 * Срок увеличен: детект дёргает `where`/`which` по десяти CLI, и на Windows под
 * параллельным прогоном всей сюиты это уходит за стандартные 5 секунд. Медленно
 * здесь — свойство диска, а не признак поломки.
 */
describe('config-routes: GET /api/providers/detect', { timeout: 30_000 }, () => {
  let root: string;
  let app: FastifyInstance;

  const boot = async (provider: string): Promise<void> => {
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });
    const store = new AppStore(appData);
    if (provider !== 'claude') store.updateSettings({ provider });

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData,
        },
      },
      store,
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerConfigRoutes(app, ctx);
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-detect-route-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('→ 200 и детект по всем провайдерам с полями cliInstalled/configPresent', async () => {
    await boot('claude');
    const res = await app.inject({ method: 'GET', url: '/api/providers/detect' });
    expect(res.statusCode).toBe(200);

    const body = res.json<ProviderDetectResponse>();
    expect(body.active).toBe('claude');
    expect(body.providers).toHaveLength(10);
    for (const item of body.providers) {
      expect(typeof item.cliInstalled).toBe('boolean');
      expect(typeof item.configPresent).toBe('boolean');
      expect(item.cliCommand).toBeTruthy();
      expect(Array.isArray(item.configPaths)).toBe(true);
      // Версия НЕ определяется: `--version` не спавним (никаких зависаний).
      expect(item).not.toHaveProperty('version');
    }
  });

  it('отдаёт активного провайдера из настроек и не ломает соседний /api/providers', async () => {
    await boot('gemini');
    const detect = await app.inject({ method: 'GET', url: '/api/providers/detect' });
    expect(detect.statusCode).toBe(200);
    expect(detect.json<ProviderDetectResponse>().active).toBe('gemini');

    // Регресс-ноль: базовый список провайдеров работает как прежде.
    const providers = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(providers.statusCode).toBe(200);
    expect(providers.json<{ active: string }>().active).toBe('gemini');
  });
});
