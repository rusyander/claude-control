import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PromptRecord, PromptSummary } from '@agentdeck/contracts/prompts';
import { PROMPT_MAX_BYTES } from '@agentdeck/contracts/prompts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerPromptRoutes } from './prompt-routes.ts';
import { builtinPromptText } from '../domains/prompts/catalog.ts';

/**
 * Каталог промптов через маршруты: что видит экран и что остаётся на диске.
 *
 * Домен проверен отдельно (`domains/prompts.test.ts`); здесь — ровно то, что
 * может сломаться только на границе HTTP: чужой идентификатор, потолок длины
 * в БАЙТАХ (кириллица весит вдвое, и потолок по символам пропустил бы вдвое
 * больше) и разница между «сохранить пустой текст» и «сбросить к встроенному».
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

describe('маршруты каталога промптов', () => {
  let root: string;
  let ctx: ServerContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-prompts-'));
    ctx = makeCtx(root);
    app = Fastify();
    registerPromptRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('список отдаёт весь каталог и говорит, что ничего не правлено', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/prompts' });
    const items = res.json<{ items: PromptSummary[] }>().items;

    expect(res.statusCode).toBe(200);
    expect(items).toHaveLength(5);
    expect(items.every((item) => !item.overridden)).toBe(true);
    expect(items.every((item) => item.bytes > 100)).toBe(true);
  });

  it('карточка несёт оба текста: рабочий и встроенный', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/prompts/image' });
    const record = res.json<PromptRecord>();

    expect(record.text).toBe(builtinPromptText('image'));
    expect(record.builtinText).toBe(builtinPromptText('image'));
    expect(record.overridden).toBe(false);
  });

  it('правка сохраняется и становится рабочим текстом', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/prompts/image',
      payload: { text: 'мой текст' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<PromptRecord>().overridden).toBe(true);

    const read = await app.inject({ method: 'GET', url: '/api/prompts/image' });
    expect(read.json<PromptRecord>().text).toBe('мой текст');
    expect(existsSync(join(root, 'agentdeck', 'prompts', 'image.md'))).toBe(true);
  });

  it('сброс возвращает встроенный текст и убирает файл правки', async () => {
    await app.inject({ method: 'PUT', url: '/api/prompts/image', payload: { text: 'мой текст' } });
    const res = await app.inject({ method: 'DELETE', url: '/api/prompts/image' });

    expect(res.statusCode).toBe(200);
    expect(res.json<PromptRecord>().text).toBe(builtinPromptText('image'));
    expect(existsSync(join(root, 'agentdeck', 'prompts', 'image.md'))).toBe(false);
  });

  it('пустой текст — это правка, а не сброс', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/prompts/image',
      payload: { text: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<PromptRecord>().overridden).toBe(true);
    expect(res.json<PromptRecord>().text).toBe('');
  });

  it('чужой идентификатор — 404, а не тихо созданный файл', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/prompts/../../etc/passwd',
      payload: { text: 'мой текст' },
    });

    expect(res.statusCode).toBe(404);
    expect(existsSync(join(root, 'agentdeck', 'prompts'))).toBe(false);
  });

  it('текст без строки — 400', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/prompts/image', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('потолок длины считается в байтах, а не в символах', async () => {
    // Кириллица — два байта на символ: строка вдвое короче потолка ПО СИМВОЛАМ
    // и при этом за него выходит.
    const text = 'я'.repeat(PROMPT_MAX_BYTES / 2 + 1);
    expect(text.length).toBeLessThan(PROMPT_MAX_BYTES);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/prompts/image',
      payload: { text },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('prompt_too_long');
  });
});
