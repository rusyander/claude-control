import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { readZip } from '../lib/zip.ts';
import type { ServerContext } from '../context.ts';
import { registerEnvTransferRoutes } from './env-transfer-routes.ts';
import { promptText, savePrompt } from '../domains/prompts.ts';
import { builtinPromptText } from '../domains/prompts/catalog.ts';

/**
 * Промпты в переносе окружения (Т4): едут ПРАВКИ, встроенные тексты остаются
 * дома.
 *
 * Проверка идёт через маршруты и через РАСПАКОВКУ архива: сверять опись значило
 * бы верить тому же коду, который её написал. Главное утверждение — последнее:
 * разворот чужого архива не может подменить встроенный текст этой панели, потому
 * что писать ему туда некуда.
 */

function makeCtx(root: string): ServerContext {
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  return {
    location: { paths: { root, appData } },
    store: new AppStore(appData),
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
}

describe('перенос окружения: промпты', () => {
  let root: string;
  let appData: string;
  let kimiHome: string;
  let outDir: string;
  let ctx: ServerContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-env-prompts-'));
    appData = join(root, 'agentdeck');
    kimiHome = join(root, 'kimi');
    outDir = join(root, 'вывод');
    mkdirSync(kimiHome, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    process.env.KIMI_CODE_HOME = kimiHome;
    writeFileSync(join(kimiHome, 'AGENTS.md'), '# правила\n', 'utf8');

    ctx = makeCtx(root);
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

  const section = async (): Promise<{ overrides: { id: string; text: string }[] } | undefined> => {
    const entries = readZip(readFileSync(await exportArchive()));
    const file = entries.find((entry) => entry.path === 'panel/prompts.json');
    return file
      ? (JSON.parse(file.data.toString('utf8')) as { overrides: { id: string; text: string }[] })
      : undefined;
  };

  it('без правок секции промптов в архиве нет вовсе', async () => {
    expect(await section()).toBeUndefined();
  });

  it('правка уезжает в архив, встроенный текст — нет', async () => {
    savePrompt(appData, 'image', 'мой текст картинки');

    const document = await section();
    expect(document?.overrides).toHaveLength(1);
    expect(document?.overrides.at(0)?.id).toBe('image');
    expect(document?.overrides.at(0)?.text).toBe('мой текст картинки');

    // Ни одного встроенного текста в архиве: панель на той стороне привезёт свой.
    const zip = readFileSync(await exportArchive()).toString('utf8');
    expect(zip).not.toContain(builtinPromptText('presentation').slice(0, 60));
  });

  it('план называет правку новой, а совпавшую — такой же', async () => {
    savePrompt(appData, 'image', 'мой текст картинки');
    const archivePath = await exportArchive();

    // Принимающая машина: правок нет вовсе.
    const clean = makeCtx(mkdtempSync(join(tmpdir(), 'cc-env-prompts-in-')));
    const target = Fastify();
    registerEnvTransferRoutes(target, clean);
    await target.ready();

    const planNew = await target.inject({
      method: 'POST',
      url: '/api/env-transfer/import/plan',
      payload: { provider: 'kimi', archivePath },
    });
    expect(
      planNew.json<{ prompts: { entries: { id: string; status: string }[] } }>().prompts,
    ).toEqual({
      entries: [
        {
          id: 'image',
          status: 'new',
          // Размер в БАЙТАХ: кириллица весит вдвое, и посчитанное по символам
          // число разошлось бы с тем, что человек видит в плане.
          bytes: Buffer.byteLength('мой текст картинки', 'utf8'),
          unknown: false,
        },
      ],
    });

    // Та же правка уже сделана здесь — статус «такая же».
    savePrompt(clean.location.paths.appData, 'image', 'мой текст картинки');
    const planSame = await target.inject({
      method: 'POST',
      url: '/api/env-transfer/import/plan',
      payload: { provider: 'kimi', archivePath },
    });
    expect(
      planSame.json<{ prompts: { entries: { status: string }[] } }>().prompts.entries.at(0)?.status,
    ).toBe('same');

    await target.close();
    rmSync(clean.location.paths.root, { recursive: true, force: true });
  });

  it('разворот пишет отмеченную правку и не трогает встроенный текст', async () => {
    savePrompt(appData, 'image', 'мой текст картинки');
    const archivePath = await exportArchive();

    const targetRoot = mkdtempSync(join(tmpdir(), 'cc-env-prompts-in-'));
    const clean = makeCtx(targetRoot);
    const target = Fastify();
    registerEnvTransferRoutes(target, clean);
    await target.ready();

    const applied = await target.inject({
      method: 'POST',
      url: '/api/env-transfer/import/apply',
      payload: { provider: 'kimi', archivePath, promptSelection: ['image'] },
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ prompts: { written: string[] } }>().prompts.written).toEqual(['image']);
    expect(promptText(clean.location.paths.appData, 'image')).toBe('мой текст картинки');
    // Соседний промпт остался встроенным: архив везёт разницу, а не каталог.
    expect(promptText(clean.location.paths.appData, 'presentation')).toBe(
      builtinPromptText('presentation'),
    );

    await target.close();
    rmSync(targetRoot, { recursive: true, force: true });
  });

  it('неотмеченная правка не пишется', async () => {
    savePrompt(appData, 'image', 'мой текст картинки');
    const archivePath = await exportArchive();

    const targetRoot = mkdtempSync(join(tmpdir(), 'cc-env-prompts-in-'));
    const clean = makeCtx(targetRoot);
    const target = Fastify();
    registerEnvTransferRoutes(target, clean);
    await target.ready();

    const applied = await target.inject({
      method: 'POST',
      url: '/api/env-transfer/import/apply',
      payload: { provider: 'kimi', archivePath, selection: [], promptSelection: [] },
    });

    // Ничего не отмечено вовсе — маршрут отказывает, а не пишет молча.
    expect(applied.statusCode).toBe(400);
    expect(promptText(clean.location.paths.appData, 'image')).toBe(builtinPromptText('image'));

    await target.close();
    rmSync(targetRoot, { recursive: true, force: true });
  });
});
