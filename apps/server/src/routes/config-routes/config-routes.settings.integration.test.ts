import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppSettings } from '@agentdeck/contracts';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { getStoredKey, setStoredKey } from '../../lib/provider-keys/provider-keys.ts';
import type { ServerContext } from '../../context.ts';
import { registerConfigRoutes } from './config-routes.ts';
import {
  applyPromptGate,
  describePromptGate,
  gateScriptPath,
} from '../../domains/prompt-gate/prompt-gate.ts';

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
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
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
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
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

  // F-19 ревью П1: переменная сильнее рычага, и карточка обязана это знать.
  it('/api/system называет порог сжатия групп из переменной панели, без неё — null', async () => {
    const saved = process.env.AGENTDECK_GROUP_COMPACT_WINDOW;
    const windowEnv = async () =>
      (await app.inject({ url: '/api/system' })).json<{ groupCompactWindowEnv: number | null }>()
        .groupCompactWindowEnv;
    try {
      process.env.AGENTDECK_GROUP_COMPACT_WINDOW = '160k';
      expect(await windowEnv()).toBe(160_000);
      // Вне границ CLI переменная не действует — и карточка её не называет.
      process.env.AGENTDECK_GROUP_COMPACT_WINDOW = '50k';
      expect(await windowEnv()).toBeNull();
      delete process.env.AGENTDECK_GROUP_COMPACT_WINDOW;
      expect(await windowEnv()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.AGENTDECK_GROUP_COMPACT_WINDOW;
      else process.env.AGENTDECK_GROUP_COMPACT_WINDOW = saved;
    }
  });

  describe('PATCH /api/settings', () => {
    it('валидный частичный патч сохраняется', async () => {
      const res = await patch({ theme: 'dark', backupKeep: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.json<AppSettings>().theme).toBe('dark');
      expect(res.json<AppSettings>().backupKeep).toBe(5);
      expect((await getSettings()).theme).toBe('dark');
    });

    // F-03: блок целиком в state.json замораживал все умолчания — их будущая
    // смена в коде до этого пользователя не доходила.
    it('рычаг экономии групп: на диске только отличия от умолчаний, в ответе — слитый блок', async () => {
      const res = await patch({ groupEconomy: { bashOutputChars: 4000 } });
      expect(res.statusCode).toBe(200);
      expect((await getSettings()).groupEconomy).toEqual({
        ...GROUP_ECONOMY_DEFAULTS,
        bashOutputChars: 4000,
      });
      const disk = JSON.parse(readFileSync(join(root, 'agentdeck', 'state.json'), 'utf8'));
      expect(disk.settings.groupEconomy).toEqual({ bashOutputChars: 4000 });
      const snapshot = JSON.parse(
        readFileSync(join(root, 'agentdeck', 'settings-snapshot.json'), 'utf8'),
      );
      expect(snapshot.state.settings.groupEconomy).toEqual({ bashOutputChars: 4000 });
      // Значение, равное умолчанию, снова следует за ним.
      await patch({ groupEconomy: { bashOutputChars: GROUP_ECONOMY_DEFAULTS.bashOutputChars } });
      const after = JSON.parse(readFileSync(join(root, 'agentdeck', 'state.json'), 'utf8'));
      expect(after.settings.groupEconomy).toEqual({});
    });

    it('частичный блок экономии с диска дополняется умолчаниями текущего кода', async () => {
      writeFileSync(
        join(root, 'agentdeck', 'state.json'),
        JSON.stringify({ settings: { groupEconomy: { compactWindow: 160_000 } } }),
      );
      expect(new AppStore(join(root, 'agentdeck')).getSettings().groupEconomy).toEqual({
        ...GROUP_ECONOMY_DEFAULTS,
        compactWindow: 160_000,
      });
    });

    it('сторож групп: правка порога сливается с сохранённым, на диске только отличия', async () => {
      expect((await getSettings()).groupWatch).toEqual(GROUP_WATCH_DEFAULTS);
      expect((await patch({ groupWatch: { stallMinutes: 30 } })).statusCode).toBe(200);
      // Второй ключ не возвращает первый к заводскому.
      expect((await patch({ groupWatch: { enabled: false } })).statusCode).toBe(200);
      expect((await getSettings()).groupWatch).toEqual({
        ...GROUP_WATCH_DEFAULTS,
        stallMinutes: 30,
        enabled: false,
      });
      const disk = JSON.parse(readFileSync(join(root, 'agentdeck', 'state.json'), 'utf8'));
      expect(disk.settings.groupWatch).toEqual({ stallMinutes: 30, enabled: false });
      expect((await patch({ groupWatch: { stallMinutes: 0 } })).statusCode).toBe(400);
    });

    it('снимок с одними отличиями рычагов импортируется и дополняется умолчаниями', async () => {
      // Снимок настроек для git пишется так же, как state.json, — отличиями.
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/import',
        payload: { settings: { groupEconomy: { sonnetDeliver: false } } },
      });
      expect(res.statusCode).toBe(200);
      expect((await getSettings()).groupEconomy).toEqual({
        ...GROUP_ECONOMY_DEFAULTS,
        sonnetDeliver: false,
      });
    });

    it('смена языка сразу пересобирает свой гейт на промпте на новом языке', async () => {
      // Сообщения гейта человек читает в CLI: без пересборки английский
      // интерфейс оставлял бы на диске русский скрипт до следующего тумблера.
      mkdirSync(join(root, 'hooks'), { recursive: true });
      writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
      const gate = {
        hooksDir: join(root, 'hooks'),
        settingsPath: join(root, 'settings.json'),
        appDataDir: join(root, 'agentdeck'),
      };
      store.updateSettings({ promptGate: { enabled: true, action: 'block' } });
      applyPromptGate(store, gate, { enabled: true, action: 'block' });
      expect(readFileSync(gateScriptPath(gate.hooksDir), 'utf8')).toContain('Гейт на промпте');

      expect((await patch({ language: 'en' })).statusCode).toBe(200);
      expect(readFileSync(gateScriptPath(gate.hooksDir), 'utf8')).toContain('Prompt gate');
      expect(describePromptGate(store, gate).outdated).toBe(false);
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

    // Владелец 10.10.2026: каждая система — своя интеграция. Снимок, снятый до
    // разделения, обязан пройти проверку и разложиться по системам, иначе одна
    // старая карточка отклоняла бы перенос всех остальных настроек.
    it('снимок с интеграциями прежней формы раскладывается по системам', async () => {
      const res = await importState({
        settings: {
          integrations: {
            atlassian: {
              enabled: true,
              baseUrl: 'https://acme.atlassian.net',
              email: 'qa@acme.io',
              deployment: 'cloud',
              confluenceUrl: '',
            },
            forge: { enabled: true, kind: 'github', baseUrl: '', repo: 'acme/panel' },
            tms: {
              enabled: false,
              kind: 'testit',
              baseUrl: 'https://tms',
              projectKey: 'P',
              groupId: '',
            },
          },
        },
        integrationHealth: { 'int:atlassian': { state: 'ok', detail: 'Вошли', checkedAt: 'x' } },
      });
      expect(res.statusCode).toBe(200);
      const { integrations } = await getSettings();
      expect(integrations.jira).toMatchObject({
        enabled: true,
        baseUrl: 'https://acme.atlassian.net',
      });
      expect(integrations.confluence.baseUrl).toBe('https://acme.atlassian.net/wiki');
      expect(integrations.github).toMatchObject({ enabled: true, repo: 'acme/panel' });
      expect(integrations.testit).toMatchObject({ baseUrl: 'https://tms', projectKey: 'P' });
      // Не названные снимком системы — дефолты, а не пропавшие ключи.
      expect(integrations.gitlab.enabled).toBe(false);
      expect(integrations).not.toHaveProperty('atlassian');
      expect(store.exportState().integrationHealth).toHaveProperty('int:jira');
    });

    // Ревью 28.09 (F-35, F-364) и решение владельца 27.09: разговоры, отпечаток
    // парольной фразы и тексты выключенных правил — этой машины; снимок с другой
    // их не стирает (правила только дополняет недостающими).
    it('здешнее остаётся здешним: разговоры, verifier, выключенные правила', async () => {
      const rule = (title: string, body: string) => ({
        title,
        body,
        after: null,
        before: null,
        index: 0,
      });
      const state = store.getState();
      state.chatGroupSettings = { 'chat-local': { autonomous: true } } as never;
      state.chatKeyAliases = { 'new-1': 'session-local' };
      state.chatEscalations = { 'chat-local': [] } as never;
      state.secretBackupVerifier = 'local-verifier';
      state.disabledRules = [rule('Local', 'only here')];

      const res = await importState({
        groups: [],
        disabledRules: [rule('local ', 'foreign twin'), rule('Foreign', 'brought')],
        settings: { theme: 'dark' },
      });
      expect(res.statusCode).toBe(200);
      const after = store.getState();
      expect(after.chatGroupSettings).toEqual({ 'chat-local': { autonomous: true } });
      expect(after.chatKeyAliases).toEqual({ 'new-1': 'session-local' });
      expect(after.chatEscalations).toEqual({ 'chat-local': [] });
      expect(after.secretBackupVerifier).toBe('local-verifier');
      expect(after.disabledRules?.map((item) => [item.title, item.body])).toEqual([
        ['Local', 'only here'],
        ['Foreign', 'brought'],
      ]);
      expect(after.settings.theme).toBe('dark');
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

  /**
   * Контуры — единственный ключ настроек, за которым тянется то, чего в
   * настройках нет: ключ в шифрохранилище и след пробы. Этот маршрут про них не
   * знает, поэтому у него есть вторая обязанность — убрать за собой.
   */
  describe('контуры через общий PATCH настроек', () => {
    const platform = {
      id: 'company-dev',
      title: 'Company · dev',
      driver: 'enterprise-platform',
      baseUrl: 'https://api.dev.example.ru',
      enabled: true,
      mode: 'required',
      budgetUsd: 0,
      capabilities: [],
      targets: [],
      projectPaths: [],
      budgetSince: '',
      toolShim: true,
      contourPrompt: true,
      caCertPath: '',
    };

    it('удалённый через настройки контур не оставляет ни ключа, ни следа пробы', async () => {
      await patch({ platforms: [platform] });
      setStoredKey(join(root, 'agentdeck'), 'platform:company-dev', 'sk-СЕКРЕТ-4f21');
      store.savePlatformHealth('company-dev', { outcome: 'ok' } as never);

      const res = await patch({ platforms: [] });

      expect(res.statusCode).toBe(200);
      expect(getStoredKey(join(root, 'agentdeck'), 'platform:company-dev')).toBeUndefined();
      expect(store.getPlatformHealth()['company-dev']).toBeUndefined();
    });

    it('идентификатор с пробелом отклонён и здесь: адрес шлюза собирается из него', async () => {
      const res = await patch({ platforms: [{ ...platform, id: 'company dev' }] });

      expect(res.statusCode).toBe(400);
      expect((await getSettings()).platforms).toEqual([]);
    });

    it('импорт чужого снимка не оставляет ключей от контуров, которых в нём нет', async () => {
      setStoredKey(join(root, 'agentdeck'), 'platform:местный', 'sk-МЕСТНЫЙ-КЛЮЧ');

      await importState({ settings: { platforms: [platform] } });

      expect(getStoredKey(join(root, 'agentdeck'), 'platform:местный')).toBeUndefined();
    });

    /**
     * Управляемый профиль эндпоинта — третья такая же зависимость. Он живёт в
     * тех же настройках, но собирается ИЗ контура: контур исчез или сменил порт
     * шлюза — профиль обязан исчезнуть или переехать вместе с ним, иначе
     * ассистент панели молча ходит на мёртвый адрес.
     */
    const managed = {
      id: 'contour-company-dev',
      name: 'Контур · Company · dev',
      baseUrl: 'http://127.0.0.1:5179/company-dev/v1',
      apiKind: 'openai-compat',
      model: 'gpt-4o',
      writeToken: false,
      ownerPlatformId: 'company-dev',
    };

    it('контур убрали — управляемый профиль ушёл, ассистент вернулся в облако', async () => {
      await patch({ platforms: [platform] });
      store.updateSettings({
        endpointProfiles: [managed as never],
        assistantEndpointId: 'contour-company-dev',
      });

      await patch({ platforms: [] });

      expect((await getSettings()).endpointProfiles).toEqual([]);
      expect((await getSettings()).assistantEndpointId).toBe('');
    });

    it('сменился порт шлюза — адрес профиля переехал сам', async () => {
      await patch({ platforms: [platform] });
      store.updateSettings({ endpointProfiles: [managed as never] });

      await patch({ platformGateway: { enabled: true, port: 5200, forceStream: true } });

      expect((await getSettings()).endpointProfiles[0]?.baseUrl).toBe(
        'http://127.0.0.1:5200/company-dev/_s/assistant/v1',
      );
    });

    it('импорт снимка без контура тоже убирает его профиль', async () => {
      await patch({ platforms: [platform] });
      store.updateSettings({ endpointProfiles: [managed as never] });

      await importState({ settings: { platforms: [] } });

      expect((await getSettings()).endpointProfiles).toEqual([]);
    });
  });
});
