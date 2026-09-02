import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderCompareRoutes } from './provider-compare-routes.ts';

/**
 * Перенос между провайдерами на уровне маршрута: куда ложится резервная копия и
 * что делается с телом не по контракту.
 *
 * Копия приёмника раньше писалась в КОРЕНЬ appData (`paths.appData`), а не в
 * общий каталог копий `ctx.backupDir` — мимо ленты истории, страницы «Копии»,
 * ротации и шифрования секретов. Тело запроса не проверялось вовсе: строка в
 * `keys` обходилась посимвольно, чужой `mode` считался предпросмотром.
 */
describe('provider-compare-routes: копии переноса и проверка тела', () => {
  let root: string;
  let codexHome: string;
  let previousCodex: string | undefined;
  let app: FastifyInstance;

  const appData = (): string => join(root, 'claude-control');
  const backups = (): string => join(appData(), 'backups');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-compare-routes-'));
    mkdirSync(appData(), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), 'правила claude\n');

    codexHome = mkdtempSync(join(tmpdir(), 'cc-compare-codex-'));
    previousCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    writeFileSync(join(codexHome, 'AGENTS.md'), 'старый текст codex\n');

    const store = new AppStore(appData());
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
          appData: appData(),
        },
      },
      store,
      // Как в настоящем контексте: копии включены → общий каталог копий.
      get backupDir(): string | undefined {
        return store.getSettings().backupBeforeWrite ? store.backupDir : undefined;
      },
    } as unknown as ServerContext;

    app = Fastify();
    registerProviderCompareRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    rmSync(root, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  const migrate = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/provider-migrate', payload: payload as object });

  it('копия приёмника ложится в каталог копий, а не в корень appData', async () => {
    const res = await migrate({
      from: 'claude',
      to: 'codex',
      section: 'instructions',
      mode: 'apply',
    });
    expect(res.statusCode).toBe(200);

    expect(existsSync(backups())).toBe(true);
    const inBackups = readdirSync(backups());
    expect(inBackups.some((name) => name.startsWith('codex-AGENTS.md.'))).toBe(true);
    expect(readdirSync(appData()).some((name) => name.endsWith('.bak'))).toBe(false);
  });

  it('тело не по контракту — 400 с причиной, файл приёмника не тронут', async () => {
    const before = readdirSync(codexHome);
    for (const payload of [
      { from: 'claude', to: 'codex', section: 'mcp', keys: 'shared', mode: 'apply' },
      { from: 'claude', to: 'codex', section: 'instructions', mode: 'bogus' },
      { from: 'claude', to: 'codex' },
    ]) {
      const res = await migrate(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string; message: string }>().error).toBe('bad_request');
      expect(res.json<{ message: string }>().message.length).toBeGreaterThan(0);
    }
    expect(readdirSync(codexHome)).toEqual(before);
    expect(existsSync(backups())).toBe(false);
  });
});
