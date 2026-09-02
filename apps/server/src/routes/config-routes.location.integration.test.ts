import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppSettings } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { detectClaudeLocation } from '../lib/claude-paths.ts';
import type { ServerContext } from '../context.ts';
import { registerConfigRoutes } from './config-routes.ts';

/**
 * POST /api/location принимал что угодно. Тело `{}` уходило в
 * `detectClaudeLocation(undefined)`, тот скатывался к CLAUDE_CONFIG_DIR/~/.claude
 * и отвечал «всё в порядке», а сохранённый ручной каталог затирался — панель
 * после перезапуска молча оказывалась в чужом. Не строка роняла `.trim()` и
 * возвращала 500 вместо объяснения.
 *
 * `relocate` здесь настоящий (`detectClaudeLocation`), иначе проверять нечего:
 * ошибка была именно в нём. CLAUDE_CONFIG_DIR подменён на временный каталог,
 * чтобы «падение к автоопределению» было одинаковым на любой машине.
 */
describe('config-routes: POST /api/location', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let envBefore: string | undefined;

  const MANUAL = 'C:/manual/.claude';

  const settings = async (): Promise<AppSettings> =>
    (await app.inject({ method: 'GET', url: '/api/settings' })).json<AppSettings>();

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/location', payload: payload as object });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-location-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    store = new AppStore(join(root, 'claude-control'));

    envBefore = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;

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
      relocate: (path: string) => detectClaudeLocation(path),
      rememberDirOverride: (value: string) => store.updateSettings({ claudeDirOverride: value }),
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;

    app = Fastify();
    registerConfigRoutes(app, ctx);
    await app.ready();

    // Пользователь однажды указал каталог руками — это значение и защищаем.
    store.updateSettings({ claudeDirOverride: MANUAL });
  });

  afterEach(async () => {
    await app.close();
    if (envBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = envBefore;
    rmSync(root, { recursive: true, force: true });
  });

  it('тело без path отклоняется и НЕ сбрасывает сохранённый каталог', async () => {
    const response = await post({});

    expect(response.statusCode).toBe(400);
    expect((await settings()).claudeDirOverride).toBe(MANUAL);
  });

  it('path не строкой — 400 с объяснением, а не 500', async () => {
    const response = await post({ path: 5 });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('путь');
    expect((await settings()).claudeDirOverride).toBe(MANUAL);
  });

  it('пустая строка тоже отклоняется: это то же самое автоопределение', async () => {
    const response = await post({ path: '   ' });

    expect(response.statusCode).toBe(400);
    expect((await settings()).claudeDirOverride).toBe(MANUAL);
  });

  it('валидный путь переезжает и запоминается', async () => {
    const response = await post({ path: root });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ source: string }>().source).toBe('manual');
    expect((await settings()).claudeDirOverride).toBe(root);
  });
});
