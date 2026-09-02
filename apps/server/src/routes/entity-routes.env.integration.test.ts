import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EnvVar } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEnvRoutes } from './entity/env-routes.ts';

/**
 * Аудит страницы «Переменные» 2026-09-02. Маршруты /api/env принимали любое
 * тело и отвечали «ok» на то, чего не делали: ключ с пробелом ломал строку
 * env-файла, перевод строки дописывал ЧУЖУЮ переменную, source `group` или
 * отсутствующий — 200 без записи, DELETE несуществующего — 200 и переписанный
 * файл, reveal несуществующего — запрос без ответа (Fastify ждал тело), перенос
 * на занятый ключ молча затирал значение. Секретом считалась любая ПОДСТРОКА:
 * путь к bash (…_PATH) и лимит токенов (…_TOKENS) прятались за маской.
 *
 * Всё во временном каталоге — настоящий ~/.claude не затрагивается.
 */
describe('маршруты /api/env: проверка тела, 404 и 409 вместо тихого «ok»', () => {
  let root: string;
  let app: FastifyInstance;
  let settingsPath: string;
  let localPath: string;
  let secretsPath: string;
  let store: AppStore;

  const settingsEnv = (): Record<string, string> =>
    JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? {};
  const localEnv = (): Record<string, string> =>
    JSON.parse(readFileSync(localPath, 'utf8')).env ?? {};
  const secrets = (): string => readFileSync(secretsPath, 'utf8');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-env-routes-'));
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });
    settingsPath = join(root, 'settings.json');
    localPath = join(root, 'settings.local.json');
    secretsPath = join(root, '.mcp-secrets.env');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          PLAIN: 'plain-1',
          PROBE_TOKEN: 'tok-1234567890abcdef',
          GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
          MAX_THINKING_TOKENS: '8000',
          DUP: 'from-settings',
        },
      }),
    );
    writeFileSync(localPath, JSON.stringify({ env: { LOCAL_ONLY: 'local-1', DUP: 'from-local' } }));
    writeFileSync(
      secretsPath,
      '# где брать\nGITLAB_TOKEN=glpat-secret\nDB_CREDENTIALS=user:pass\n',
    );

    // state.json — явно: свежий AppStore без него делит массивы с DEFAULT_STATE
    // по ссылке, и группы протекали бы между тестами (см. mcp.test.ts).
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );
    store = new AppStore(appData);
    const ctx = {
      location: {
        paths: {
          root,
          appData,
          settings: settingsPath,
          settingsLocal: localPath,
          secretsEnv: secretsPath,
        },
      },
      store,
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerEnvRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const list = async (): Promise<EnvVar[]> =>
    (await app.inject({ method: 'GET', url: '/api/env' })).json<EnvVar[]>();
  const find = async (source: string, key: string): Promise<EnvVar | undefined> =>
    (await list()).find((item) => item.source === source && item.key === key);

  describe('секрет — по целому слову в имени, одно правило с формой', () => {
    it('TOKEN и CREDENTIALS как слова — секреты, замаскированы', async () => {
      expect(await find('settings', 'PROBE_TOKEN')).toMatchObject({ isSecret: true });
      expect((await find('settings', 'PROBE_TOKEN'))?.value).not.toContain('1234567890');
      expect(await find('secrets', 'DB_CREDENTIALS')).toMatchObject({ isSecret: true });
    });

    it('PATH и TOKENS — не секреты: подстрока PAT/TOKEN не считается', async () => {
      expect(await find('settings', 'GIT_BASH_PATH')).toMatchObject({
        isSecret: false,
        value: 'C:/Program Files/Git/bin/bash.exe',
      });
      expect(await find('settings', 'MAX_THINKING_TOKENS')).toMatchObject({
        isSecret: false,
        value: '8000',
      });
    });
  });

  describe('POST /api/env — тело проверяется до записи', () => {
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/env', payload });

    it('ключ с пробелом или переводом строки — 400 с причиной, файл секретов нетронут', async () => {
      const before = secrets();
      for (const key of ['BAD KEY', 'A\nEVIL=1', '1STARTS_WITH_DIGIT', '']) {
        const res = await post({ key, value: 'x', source: 'secrets' });
        expect(res.statusCode, JSON.stringify(key)).toBe(400);
        expect(res.json<{ message: string }>().message).toContain('Имя переменной');
      }
      expect(secrets()).toBe(before);
    });

    it('перевод строки в значении секрета — 400: вторая строка стала бы переменной', async () => {
      const before = secrets();
      const res = await post({ key: 'NL_VALUE', value: 'a\nEVIL2=1', source: 'secrets' });
      expect(res.statusCode).toBe(400);
      expect(secrets()).toBe(before);
    });

    it('без source, с source «group» или с числом вместо значения — 400, ничего не записано', async () => {
      const settingsBefore = readFileSync(settingsPath, 'utf8');
      for (const payload of [
        { key: 'NO_SOURCE', value: 'x' },
        { key: 'GRP', value: 'x', source: 'group' },
        { key: 'NUM', value: 42, source: 'settings' },
      ]) {
        const res = await post(payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json<{ error: string }>().error).toBe('invalid_env_draft');
      }
      expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
      expect(secrets()).not.toContain('GRP=');
    });

    it('правильный черновик записывается, ответ помечает нужный перезапуск', async () => {
      const res = await post({ key: 'NEW_ONE', value: 'v', source: 'settings' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, needsRestart: true });
      expect(settingsEnv().NEW_ONE).toBe('v');
    });
  });

  describe('GET /api/env/reveal', () => {
    it('существующий секрет — полное значение текстом', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/env/reveal?key=GITLAB_TOKEN&source=secrets',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('glpat-secret');
    });

    it('несуществующий ключ — 404 с причиной, а не запрос без ответа', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/env/reveal?key=NOPE&source=secrets',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'env_not_found' });
      expect(res.json<{ message: string }>().message).toContain('NOPE');
    });

    it('без source — 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/env/reveal?key=GITLAB_TOKEN' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/env', () => {
    it('несуществующий ключ — 404, файлы не переписаны', async () => {
      const secretsBefore = secrets();
      const settingsBefore = readFileSync(settingsPath, 'utf8');

      for (const source of ['secrets', 'settings', 'settings-local']) {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/env?key=NOPE&source=${source}`,
        });
        expect(res.statusCode, source).toBe(404);
      }
      expect(secrets()).toBe(secretsBefore);
      expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    });

    it('существующий — удаляется вместе со своим комментарием', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/env?key=GITLAB_TOKEN&source=secrets',
      });
      expect(res.statusCode).toBe(200);
      expect(secrets()).not.toContain('GITLAB_TOKEN=');
      expect(secrets()).not.toContain('где брать');
      expect(secrets()).toContain('DB_CREDENTIALS=user:pass');
    });
  });

  describe('POST /api/env/:key/move', () => {
    const move = (key: string, source: string) =>
      app.inject({ method: 'POST', url: `/api/env/${key}/move`, payload: { source } });

    it('в приёмнике уже есть такой ключ — 409, оба значения на месте', async () => {
      const res = await move('DUP', 'settings');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'env_exists' });
      expect(settingsEnv().DUP).toBe('from-settings');
      expect(localEnv().DUP).toBe('from-local');
    });

    it('переносить нечего — 404', async () => {
      const res = await move('NOPE', 'settings');
      expect(res.statusCode).toBe(404);
    });

    it('секрет из .mcp-secrets.env — 400, файл нетронут', async () => {
      const before = secrets();
      const res = await move('GITLAB_TOKEN', 'secrets');
      expect(res.statusCode).toBe(400);
      expect(secrets()).toBe(before);
    });

    it('обычный перенос: из общего в личный и обратно', async () => {
      expect((await move('PLAIN', 'settings')).statusCode).toBe(200);
      expect(settingsEnv().PLAIN).toBeUndefined();
      expect(localEnv().PLAIN).toBe('plain-1');

      expect((await move('PLAIN', 'settings-local')).statusCode).toBe(200);
      expect(settingsEnv().PLAIN).toBe('plain-1');
      expect(localEnv().PLAIN).toBeUndefined();
    });
  });

  // Аудит «Группы» 2026-09-03: ключ включённой группы лежит в settings.json, но
  // хозяин у него — группа; список отдавал его как обычный settings, и страница
  // давала удалить то, что группа вернёт при следующем включении.
  describe('переменные групп в списке', () => {
    const envGroup = {
      id: 'g-env',
      name: 'env group',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: { PLAIN: 'plain-1', PROBE_TOKEN: 'tok-1234567890abcdef' },
      isEnabled: true,
      order: 0,
    };

    beforeEach(() => {
      store.saveGroup(envGroup);
    });

    it('GET отдаёт их с source group и groupId, показ значения работает', async () => {
      expect(await find('group', 'PLAIN')).toMatchObject({ id: 'group:PLAIN', groupId: 'g-env' });
      expect(await find('settings', 'PLAIN')).toBeUndefined();
      // Секрет группы замаскирован как и прежде, а полное значение читается из settings.json.
      expect((await find('group', 'PROBE_TOKEN'))?.value).not.toContain('1234567890');
      const reveal = await app.inject({
        method: 'GET',
        url: '/api/env/reveal?key=PROBE_TOKEN&source=group',
      });
      expect(reveal.statusCode).toBe(200);
      expect(reveal.body).toBe('tok-1234567890abcdef');
      // Чужие записи не тронуты.
      expect(await find('settings', 'GIT_BASH_PATH')).toBeDefined();
      expect(await find('settings-local', 'DUP')).toBeDefined();
    });

    it('удалить и перенести переменную группы по её source нельзя — файл цел', async () => {
      const before = readFileSync(settingsPath, 'utf8');
      const remove = await app.inject({ method: 'DELETE', url: '/api/env?key=PLAIN&source=group' });
      expect(remove.statusCode).toBe(400);
      const move = await app.inject({
        method: 'POST',
        url: '/api/env/PLAIN/move',
        payload: { source: 'group' },
      });
      expect(move.statusCode).toBe(400);
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    it('выключенная группа ключей не помечает', async () => {
      store.saveGroup({ ...envGroup, isEnabled: false });
      expect(await find('settings', 'PLAIN')).toBeDefined();
      expect(await find('group', 'PLAIN')).toBeUndefined();
    });
  });
});
