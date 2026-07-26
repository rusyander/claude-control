import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatRoutes, isRetriableRunError } from './chat-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';

/**
 * Интеграционные тесты маршрутов проектов и файловой системы: реальный Fastify,
 * реальные домены, временные каталоги вместо настоящего ~/.claude. Проверяем
 * склейку маршрут↔домен↔сериализация через inject. `open-in-editor` — только
 * валидацию: успех реально запустил бы редактор. Тест-кейсы см.
 * .agent/TEST-CASES.md → «Маршруты проектов/ФС (интеграция)».
 */
describe('маршруты чата: проекты и ФС', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-routes-'));
    mkdirSync(join(root, 'projects', 'enc-a'), { recursive: true });
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    // Транскрипт настоящего проекта — cwd указывает на существующий каталог.
    const realProject = mkdtempSync(join(tmpdir(), 'cc-realproj-'));
    writeFileSync(
      join(root, 'projects', 'enc-a', 'sess.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-18T10:00:00.000Z',
        cwd: realProject,
        message: { role: 'user', content: 'привет' },
      }) + '\n',
    );

    const ctx = {
      location: { paths: { root } },
      store: new AppStore(join(root, 'claude-control')),
    } as unknown as ServerContext;

    app = Fastify();
    registerChatRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/chats/projects возвращает проект из истории', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats/projects' });
    expect(res.statusCode).toBe(200);
    const projects = res.json() as Array<{ path: string; exists: boolean; chats: unknown[] }>;
    expect(projects.length).toBe(1);
    expect(projects[0]?.exists).toBe(true);
    expect(projects[0]?.chats.length).toBe(1);
  });

  it('GET /api/fs/roots содержит домашнюю папку', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/roots' });
    expect(res.statusCode).toBe(200);
    const roots = res.json() as Array<{ name: string }>;
    expect(roots.some((entry) => entry.name === '~')).toBe(true);
  });

  it('GET /api/fs/list по каталогу отдаёт подпапки', async () => {
    mkdirSync(join(root, 'sub-x'));
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/list?path=${encodeURIComponent(root)}`,
    });
    expect(res.statusCode).toBe(200);
    const listing = res.json() as { entries: Array<{ name: string }> };
    expect(listing.entries.some((entry) => entry.name === 'sub-x')).toBe(true);
  });

  it('GET /api/fs/list без пути → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list' });
    expect(res.statusCode).toBe(400);
  });

  // Маршрут спрашивает систему про каждый известный редактор (`where`/`which`
  // синхронным запуском) — под полной нагрузкой набора это дольше пяти секунд.
  it('GET /api/editors перечисляет редакторы с флагом available', { timeout: 30_000 }, async () => {
    const res = await app.inject({ method: 'GET', url: '/api/editors' });
    expect(res.statusCode).toBe(200);
    const editors = res.json() as Array<{ command: string; available: boolean }>;
    expect(editors.some((editor) => editor.command === 'code')).toBe(true);
  });

  it('POST /api/projects/open-in-editor с несуществующим путём → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open-in-editor',
      payload: { path: 'C:/nope/gone-xyz' },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Признак временности сбоя ставит сервер, и только для ошибок самого CLI:
 * клиент по тексту не решает ничего. Раньше шаблон крутился на клиенте и ловил
 * пользовательский ввод, попавший в текст отказа (имя файла), — отсюда молчаливые
 * переотправки заведомо отклонённого сообщения.
 */
describe('isRetriableRunError', () => {
  it('обрыв связи, перегрузка и таймаут — временные', () => {
    expect(isRetriableRunError('ECONNRESET')).toBe(true);
    expect(isRetriableRunError('API error 529 overloaded')).toBe(true);
    expect(isRetriableRunError('request timed out')).toBe(true);
  });

  it('отказ по правам, лимиту и неверному ключу — постоянные', () => {
    expect(isRetriableRunError('Permission denied: Bash')).toBe(false);
    expect(isRetriableRunError('Недостаточно прав на запись')).toBe(false);
    expect(isRetriableRunError('Invalid API key')).toBe(false);
  });
});

/**
 * Регрессии отправки сообщения и смены каталога конфигурации. Настоящий CLI не
 * запускаем: реестр прогонов передаём снаружи с управляемым фейком, а оба
 * проверяемых отказа происходят ДО запуска агента и до записи вложений.
 */
describe('маршруты чата: отказы отправки и смена каталога', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let registry: ChatRunRegistry;
  let created: FakeChatRun[];

  /** Прогон, который никогда не завершается сам, — держит чат «занятым». */
  class FakeChatRun implements RunLike {
    stopped = false;
    start(): Promise<void> {
      return new Promise<void>(() => {});
    }
    stop(): void {
      this.stopped = true;
    }
  }

  /** Каталог конфигурации с одним разговором внутри указанного проекта. */
  const makeConfigDir = (encoded: string): { configRoot: string; projectDir: string } => {
    const configRoot = mkdtempSync(join(tmpdir(), 'cc-cfg-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'cc-proj-'));
    mkdirSync(join(configRoot, 'projects', encoded), { recursive: true });
    mkdirSync(join(configRoot, 'claude-control'), { recursive: true });
    writeFileSync(
      join(configRoot, 'projects', encoded, 'sess.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-18T10:00:00.000Z',
        cwd: projectDir,
        message: { role: 'user', content: 'привет' },
      }) + '\n',
    );
    return { configRoot, projectDir };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-send-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    created = [];
    registry = new ChatRunRegistry(() => {
      const run = new FakeChatRun();
      created.push(run);
      return run;
    });

    ctx = {
      location: { paths: { root } },
      store: new AppStore(join(root, 'claude-control')),
    } as unknown as ServerContext;

    app = Fastify();
    registerChatRoutes(app, ctx, registry);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Тело отказа: структурный код, текст для показа и подробности. */
  const refusal = (
    body: string,
  ): { code?: string; message?: string; files?: string[]; runId?: string } =>
    JSON.parse(body) as { code?: string; message?: string; files?: string[]; runId?: string };

  // Регрессия: второе сообщение при идущем прогоне маршрут раньше глотал молча
  // и переигрывал человеку прошлый ответ.
  it('второе сообщение при идущем прогоне → отказ 409 с кодом, промпт не подменяется чужим', async () => {
    expect(registry.start('c1', { prompt: 'первое', cwd: root }, {})).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'c1', prompt: 'второе' },
    });

    expect(res.statusCode).toBe(409);
    const body = refusal(res.body);
    expect(body.code).toBe('run_busy');
    expect(body.message).toContain('ещё генерируется');
    // Ключ живого прогона — по нему клиент подключается к нему потоком и
    // получает обратно кнопку «Остановить», а не упирается в отказ.
    expect(body.runId).toBe('c1');
    // Второго процесса не завели, чужой поток не переиграли.
    expect(created.length).toBe(1);
  });

  /**
   * Регрессия (двойной запуск): вторая вкладка знает разговор по sessionId,
   * первая ведёт его под временным `new-…`. Отказ обязан назвать ключ, под
   * которым прогон РЕАЛЬНО живёт, — иначе подключиться к нему нечем.
   */
  it('отказ по sessionId называет настоящий ключ прогона', async () => {
    expect(registry.start('new-9', { prompt: 'первое', cwd: root }, { sessionId: 'sess-9' })).toBe(
      true,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'sess-9', prompt: 'второе', sessionId: 'sess-9' },
    });

    expect(res.statusCode).toBe(409);
    expect(refusal(res.body).runId).toBe('new-9');
    expect(created.length).toBe(1);
  });

  // Регрессия: файл с расширением вне белого списка исчезал без единого слова.
  // И вторая, из-за которой отказ переехал на HTTP-статус: имя файла попадало в
  // текст ошибки, а клиент по тексту решал, «временный» ли это сбой — файл
  // `network.zip` устраивал две молчаливые переотправки.
  it('вложение неподдерживаемого типа → 415 с кодом и списком имён, агент не запускается', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: 'c-files',
        prompt: 'разбери этот файл',
        files: [{ name: 'network.zip', base64: Buffer.from('select 1').toString('base64') }],
      },
    });

    expect(res.statusCode).toBe(415);
    const body = refusal(res.body);
    expect(body.code).toBe('unsupported_upload');
    // Имена — отдельным полем: клиент собирает текст сам, на своём языке.
    expect(body.files).toEqual(['network.zip']);
    expect(body.message).toContain('network.zip');
    expect(body.message).toContain('.pdf');
    expect(created.length).toBe(0);
    expect(registry.has('c-files')).toBe(false);
  });

  /**
   * Отказ отдаётся статусом и кодом, а НЕ событием потока. Клиент по нему
   * решает структурно: показать текст, не ретраить, подключиться к живому
   * прогону. Поле `retriable` в отказе не появляется вовсе — им помечаются
   * только ошибки самого CLI (см. isRetriableRunError).
   */
  it('отказ не является событием потока и не несёт признака временности', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: 'c-plain',
        prompt: 'привет',
        files: [{ name: 'report 503.pdf.zip', base64: '' }],
      },
    });

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.kind).toBeUndefined();
    expect(body.retriable).toBeUndefined();
    expect(body.code).toBe('unsupported_upload');
  });

  // Регрессия: папка projects бралась один раз при регистрации маршрутов, и
  // после смены каталога конфигурации чат читал ПРЕЖНИЙ каталог до перезапуска.
  it('смена каталога конфигурации меняет источник разговоров без перезапуска', async () => {
    const first = makeConfigDir('enc-a');
    const second = makeConfigDir('enc-b');

    ctx.location = { paths: { root: first.configRoot } } as ServerContext['location'];
    const before = await app.inject({ method: 'GET', url: '/api/chats/projects' });
    expect((before.json() as Array<{ path: string }>)[0]?.path).toBe(first.projectDir);

    ctx.location = { paths: { root: second.configRoot } } as ServerContext['location'];
    const after = await app.inject({ method: 'GET', url: '/api/chats/projects' });
    expect((after.json() as Array<{ path: string }>)[0]?.path).toBe(second.projectDir);

    for (const dir of [first.configRoot, first.projectDir, second.configRoot, second.projectDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
