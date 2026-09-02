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
 * Серверная валидация настроек и импорта состояния. Тело этих маршрутов приходит
 * от клиента, а раньше писалось в state.json без проверки: кривое значение или
 * подсунутый снимок оседали в файле как есть. Проверяем на живом Fastify тем же
 * маршрутом, что дёргает панель: валидное проходит, кривое — 400 без записи.
 */
describe('config-routes: валидация настроек и импорта', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let relocated: string[];

  const getSettings = async (): Promise<AppSettings> =>
    (await app.inject({ method: 'GET', url: '/api/settings' })).json<AppSettings>();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-config-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    store = new AppStore(join(root, 'claude-control'));
    relocated = [];

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
      // Импорт применяет глобальные настройки ввода-вывода разом (глубина
      // ротации, шифрование копий секретов, имя файла секретов) — у настоящего
      // контекста это один метод, здесь достаточно заглушки.
      applyIoSettings: () => {},
      relocate: (path: string) => {
        relocated.push(path);
        return { isValid: true };
      },
      rememberDirOverride: (value: string) => store.updateSettings({ claudeDirOverride: value }),
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

  const patch = (payload: unknown) =>
    app.inject({ method: 'PATCH', url: '/api/settings', payload: payload as object });
  const importState = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/settings/import', payload: payload as object });

  describe('PATCH /api/settings', () => {
    it('валидный частичный патч сохраняется', async () => {
      const res = await patch({ theme: 'dark', backupKeep: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.json<AppSettings>().theme).toBe('dark');
      expect(res.json<AppSettings>().backupKeep).toBe(5);
      expect((await getSettings()).theme).toBe('dark');
    });

    it('невалидное значение enum отклоняется 400 и не пишется', async () => {
      const res = await patch({ theme: 'неон' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_settings');
      // Тема осталась дефолтной — мусор в state.json не попал.
      expect((await getSettings()).theme).toBe('system');
    });

    it('нечисловой backupKeep отклоняется 400', async () => {
      const res = await patch({ backupKeep: 'много' });
      expect(res.statusCode).toBe(400);
      expect((await getSettings()).backupKeep).toBe(10);
    });

    it('backupKeep вне диапазона по-прежнему ужимается, а не отклоняется', async () => {
      const res = await patch({ backupKeep: 100000 });
      expect(res.statusCode).toBe(200);
      expect(res.json<AppSettings>().backupKeep).toBe(100);
    });

    it('неизвестные поля отбрасываются, а не оседают в state.json', async () => {
      const res = await patch({ theme: 'dark', сомнительное: 123 });
      expect(res.statusCode).toBe(200);
      expect(store.getSettings()).not.toHaveProperty('сомнительное');
    });

    it('смена каталога через настройки вызывает relocate валидным значением', async () => {
      const res = await patch({ claudeDirOverride: 'C:/other/.claude' });
      expect(res.statusCode).toBe(200);
      expect(relocated).toContain('C:/other/.claude');
    });
  });

  describe('POST /api/settings/import', () => {
    it('снимок собственного exportState импортируется (round-trip)', async () => {
      store.saveGroup({
        id: 'g1',
        name: 'Набор',
        description: '',
        color: 'accent',
        icon: 'folder',
        members: [],
        env: {},
        isEnabled: true,
        order: 0,
      });
      const snapshot = store.exportState();

      const res = await importState(snapshot);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
    });

    it('валидный частичный снимок применяется', async () => {
      const res = await importState({ settings: { theme: 'dark' } });
      expect(res.statusCode).toBe(200);
      expect((await getSettings()).theme).toBe('dark');
    });

    it('тело не объект (массив) отклоняется 400', async () => {
      const res = await importState([1, 2, 3]);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_state');
    });

    it('структурно кривой снимок (groups не массив) отклоняется 400 и не применяется', async () => {
      const res = await importState({ groups: 'не массив', settings: { theme: 'dark' } });
      expect(res.statusCode).toBe(400);
      // Ничего не применилось — тема осталась дефолтной.
      expect((await getSettings()).theme).toBe('system');
    });

    it('кривые настройки внутри снимка отклоняются 400', async () => {
      const res = await importState({ settings: { backupKeep: 'нет' } });
      expect(res.statusCode).toBe(400);
    });
  });
});
