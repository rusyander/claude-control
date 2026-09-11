import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { getStoredKey, setStoredKey } from '../lib/provider-keys.ts';
import { readZip } from '../lib/zip.ts';
import type { ServerContext } from '../context.ts';
import { registerEnvTransferRoutes } from './env-transfer-routes.ts';

/**
 * Контур в переносе окружения (Т12): настройка уезжает, КЛЮЧ остаётся.
 *
 * Проверка идёт через маршруты, а не через домен, потому что утечь ключ может
 * только здесь: домен переноса получает `Platform`, в котором поля ключа нет
 * вовсе, а маршрут — единственное место, где рядом оказываются и настройка, и
 * шифрохранилище. И архив читается РАСПАКОВКОЙ: сверять опись значило бы верить
 * тому же коду, который её и написал.
 */
/**
 * Ключи-подстановки. Латиница обязательна: с Т12 ключ вне печатного ASCII панель
 * не сохраняет вовсе (`store.assertToken`) — он не уйдёт в заголовке. Строки
 * остаются приметными: их ищут по всему архиву побайтно.
 */
const TOKEN = 'CONTOUR-KEY-TRANSFER-9f31';

/** Ключ, который на принимающей машине УЖЕ лежит — под её собственный адрес. */
const LOCAL_TOKEN = 'CONTOUR-KEY-LOCAL-1234';

function makeCtx(root: string): ServerContext {
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  return {
    location: { paths: { root, appData } },
    store: new AppStore(appData),
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
}

const contour = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform' as const,
  baseUrl: 'https://api.example.ru',
  enabled: true,
  mode: 'required' as const,
  budgetUsd: 25,
  budgetSince: '2026-09-01',
  capabilities: ['chat' as const],
  targets: ['assistant'],
  projectPaths: ['C:\\work\\старая-машина'],
  agents: [],
  caCertPath: '',
};

describe('перенос окружения: контуры', () => {
  let root: string;
  let appData: string;
  let kimiHome: string;
  let outDir: string;
  let ctx: ServerContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-env-platform-'));
    appData = join(root, 'agentdeck');
    kimiHome = join(root, 'kimi');
    outDir = join(root, 'вывод');
    mkdirSync(kimiHome, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    process.env.KIMI_CODE_HOME = kimiHome;
    writeFileSync(join(kimiHome, 'AGENTS.md'), '# правила\n', 'utf8');

    ctx = makeCtx(root);
    ctx.store.updateSettings({ platforms: [contour] });
    setStoredKey(appData, `platform:${contour.id}`, TOKEN);

    app = Fastify();
    registerEnvTransferRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.KIMI_CODE_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  const exportArchive = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/export',
      payload: { provider: 'kimi', targetDir: outDir },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ path: string }>().path;
  };

  it('архив несёт настройку контура', async () => {
    const entries = readZip(readFileSync(await exportArchive()));
    const section = entries.find((entry) => entry.path === 'panel/platforms.json');
    expect(section).toBeDefined();

    const document = JSON.parse(section!.data.toString('utf8')) as {
      platforms: { id: string; baseUrl: string; budgetUsd: number }[];
      gateway: { port: number };
    };
    expect(document.platforms).toHaveLength(1);
    expect(document.platforms.at(0)?.id).toBe('enterprise-platform-dev');
    expect(document.platforms.at(0)?.baseUrl).toBe('https://api.example.ru');
    expect(document.platforms.at(0)?.budgetUsd).toBe(25);
    expect(document.gateway.port).toBeGreaterThan(0);
  });

  it('ключа контура нет НИ В ОДНОМ байте архива', async () => {
    const zip = readFileSync(await exportArchive());
    // Сначала целиком: ключ не должен пережить даже случайного попадания в
    // имя файла или в сжатый поток.
    expect(zip.includes(Buffer.from(TOKEN, 'utf8'))).toBe(false);
    // И отдельно по записям: zip хранит их сжатыми, и совпадение по сырым
    // байтам архива можно было бы пропустить.
    for (const entry of readZip(zip)) {
      expect(entry.data.toString('utf8')).not.toContain(TOKEN);
    }
  });

  it('чек-лист называет ключ контура — иначе на новой машине его не хватятся', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/env-transfer/preview?provider=kimi' });
    const preview = res.json<{
      platforms: { id: string }[];
      checklist: { reason: string; keys: string[] }[];
    }>();
    expect(preview.platforms.map((item) => item.id)).toEqual(['enterprise-platform-dev']);
    const line = preview.checklist.find((item) => item.reason === 'panel-key');
    expect(line?.keys.join()).toContain('enterprise-platform-dev');
  });

  it('план на чистой машине: контур новый, ключа нет, пути проектов названы чужими', async () => {
    const path = await exportArchive();

    // Другая машина: те же маршруты, но пустое состояние и пустое хранилище.
    const other = mkdtempSync(join(tmpdir(), 'cc-env-platform-2-'));
    const otherCtx = makeCtx(other);
    const otherApp = Fastify();
    registerEnvTransferRoutes(otherApp, otherCtx);
    await otherApp.ready();

    try {
      const res = await otherApp.inject({
        method: 'POST',
        url: '/api/env-transfer/import/plan',
        payload: { provider: 'kimi', archivePath: path },
      });
      expect(res.statusCode).toBe(200);

      const plan = res.json<{
        platforms?: {
          entries: { id: string; status: string; hasToken: boolean; notes: string[] }[];
        };
      }>();
      const entry = plan.platforms?.entries[0];
      expect(entry?.status).toBe('new');
      expect(entry?.hasToken).toBe(false);
      expect(entry?.notes.join(' ')).toContain('введите его после разворота');
      expect(entry?.notes.join(' ')).toContain('пути проектов');
    } finally {
      await otherApp.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('разворот пишет контур в настройки и НЕ создаёт ключ', async () => {
    const path = await exportArchive();

    const other = mkdtempSync(join(tmpdir(), 'cc-env-platform-3-'));
    const otherData = join(other, 'agentdeck');
    const otherCtx = makeCtx(other);
    const otherApp = Fastify();
    registerEnvTransferRoutes(otherApp, otherCtx);
    await otherApp.ready();

    try {
      const res = await otherApp.inject({
        method: 'POST',
        url: '/api/env-transfer/import/apply',
        payload: {
          provider: 'kimi',
          archivePath: path,
          selection: [],
          platformSelection: ['enterprise-platform-dev'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ platforms: { written: string[] } }>().platforms.written).toEqual([
        'enterprise-platform-dev',
      ]);

      const moved = otherCtx.store.getSettings().platforms;
      expect(moved).toHaveLength(1);
      expect(moved.at(0)?.baseUrl).toBe('https://api.example.ru');
      // Ключа нет, и контур приехал включённым: панель ответит «не подключён»,
      // а не уйдёт наружу с пустым заголовком.
      expect(getStoredKey(otherData, 'platform:enterprise-platform-dev')).toBeUndefined();
      expect(moved.at(0)?.enabled).toBe(true);

      // Управляемого профиля от переноса НЕ появляется, и это намеренно: профиль
      // порождает применение контура к целям (Т3), а перенос настройки — не
      // применение. Иначе на новой машине CLI молча получил бы адрес шлюза,
      // которого человек здесь не включал.
      const profiles = otherCtx.store.getSettings().endpointProfiles;
      expect(profiles.some((profile) => profile.ownerPlatformId === 'enterprise-platform-dev')).toBe(false);
    } finally {
      await otherApp.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('второй разворот в машину с тем же контуром показывает «перезапишет»', async () => {
    const path = await exportArchive();

    const other = mkdtempSync(join(tmpdir(), 'cc-env-platform-4-'));
    const otherCtx = makeCtx(other);
    otherCtx.store.updateSettings({
      platforms: [{ ...contour, baseUrl: 'https://api.другой.ру', budgetUsd: 5 }],
    });
    setStoredKey(join(other, 'agentdeck'), 'platform:enterprise-platform-dev', 'sk-местный-ключ-1234');

    const otherApp = Fastify();
    registerEnvTransferRoutes(otherApp, otherCtx);
    await otherApp.ready();

    try {
      const res = await otherApp.inject({
        method: 'POST',
        url: '/api/env-transfer/import/plan',
        payload: { provider: 'kimi', archivePath: path },
      });
      const entry = res.json<{
        platforms?: { entries: { status: string; hasToken: boolean; notes: string[] }[] };
      }>().platforms?.entries[0];
      expect(entry?.status).toBe('differs');
      expect(entry?.hasToken).toBe(true);
      // Адрес в архиве ДРУГОЙ, а ключ на этой машине живой. Успокоительное «ключ
      // уже сохранён» здесь — ровно то, чего говорить нельзя: человек прочитал бы
      // его как «ничего делать не надо» и одной галочкой отправил бы
      // корпоративный ключ на адрес из чужого zip.
      expect(entry?.notes.join(' ')).toContain('адрес другой');
      expect(entry?.notes.join(' ')).toContain('ключ будет снят');
      expect(entry?.notes.join(' ')).not.toContain('уже сохранён');
    } finally {
      await otherApp.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('разворот с ДРУГИМ адресом снимает ключ и след пробы, но не расход', async () => {
    const path = await exportArchive();

    const other = mkdtempSync(join(tmpdir(), 'cc-env-platform-5-'));
    const otherData = join(other, 'agentdeck');
    const otherCtx = makeCtx(other);
    otherCtx.store.updateSettings({
      platforms: [{ ...contour, baseUrl: 'https://api.local.test' }],
    });
    setStoredKey(otherData, 'platform:enterprise-platform-dev', LOCAL_TOKEN);
    otherCtx.store.savePlatformHealth('enterprise-platform-dev', {
      outcome: 'ok',
      checkedAt: '2026-09-10T10:00:00.000Z',
      reachable: true,
      url: 'https://api.local.test/v1/models',
      detail: 'Контур ответил: моделей 3.',
      models: [],
      capabilities: [],
      limits: {},
      notes: [],
      compromises: [],
    });
    otherCtx.store.savePlatformSpend({
      platformId: 'enterprise-platform-dev',
      days: [
        {
          day: '2026-09-10',
          requests: 4,
          promptTokens: 100,
          completionTokens: 40,
          totalTokens: 140,
          money: { usd: 0.7, pricedTokens: 140, unpricedTokens: 0, unpricedModels: [] },
        },
      ],
    });

    const otherApp = Fastify();
    registerEnvTransferRoutes(otherApp, otherCtx);
    await otherApp.ready();

    try {
      const res = await otherApp.inject({
        method: 'POST',
        url: '/api/env-transfer/import/apply',
        payload: {
          provider: 'kimi',
          archivePath: path,
          selection: [],
          platformSelection: ['enterprise-platform-dev'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ platforms: { keysDropped: string[] } }>().platforms.keysDropped).toEqual([
        'enterprise-platform-dev',
      ]);

      // Адрес стал тем, что в архиве, — и уходить туда с прежним ключом панель
      // не станет: ключ выдавали ПОД ТОТ адрес.
      expect(otherCtx.store.getSettings().platforms.at(0)?.baseUrl).toBe('https://api.example.ru');
      expect(getStoredKey(otherData, 'platform:enterprise-platform-dev')).toBeUndefined();
      // След пробы принадлежал прежнему адресу: оставить его значило бы показать
      // зелёную галку про адрес, по которому панель не ходила ни разу.
      expect(otherCtx.store.getPlatformHealth()['enterprise-platform-dev']).toBeUndefined();
      // А расход — настоящие траты этой машины, и стирать их за человека нельзя.
      expect(otherCtx.store.getPlatformSpend()['enterprise-platform-dev']?.days?.length).toBe(1);
    } finally {
      await otherApp.close();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('одна отмеченная настройка шлюза принимается сама по себе', async () => {
    const path = await exportArchive();

    const other = mkdtempSync(join(tmpdir(), 'cc-env-platform-6-'));
    const otherCtx = makeCtx(other);
    const otherApp = Fastify();
    registerEnvTransferRoutes(otherApp, otherCtx);
    await otherApp.ready();

    try {
      // Кнопка на экране включается от одной этой галочки, и маршрут обязан её
      // принять: иначе человек нажимает включённую кнопку и получает «не
      // отмечено ни одной записи» на прямо отмеченную запись.
      const res = await otherApp.inject({
        method: 'POST',
        url: '/api/env-transfer/import/apply',
        payload: {
          provider: 'kimi',
          archivePath: path,
          selection: [],
          platformSelection: [],
          applyGateway: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ platforms: { gateway: boolean } }>().platforms.gateway).toBe(true);
      expect(otherCtx.store.getSettings().platformGateway.port).toBe(
        ctx.store.getSettings().platformGateway.port,
      );
      // Ни одного контура при этом не записано: отмечен был только шлюз.
      expect(otherCtx.store.getSettings().platforms).toEqual([]);
    } finally {
      await otherApp.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});
