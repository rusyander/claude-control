import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestDraft } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../../domains/project-tests.ts';
import { FULL_READ_LIMIT } from '../../domains/chat/ChatTranscriptFile.ts';
import { registerProjectTestsRoutes } from '../project-tests-routes.ts';

/**
 * «Сделать кейс» из чата через настоящий маршрут (Ф19, Ф20, Ф15): подменён
 * только каталог конфигурации — транскрипты лежат в нём файлами, как у
 * Claude Code.
 *
 * - Ф19: черновик пишется лишь в проект реестра (или его копию), а чат берётся
 *   лишь свой — чужой каталог и чужой разговор отказаны.
 * - Ф15: транскрипт больше `FULL_READ_LIMIT` читается целиком: шаг из середины
 *   файла в черновике есть.
 */
const CHAT = 'aaaa1111-2222-4333-8444-555566667777';
const FOREIGN_CHAT = 'bbbb1111-2222-4333-8444-555566667777';

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const human = (cwd: string, text: string) =>
  line({ type: 'user', cwd, message: { role: 'user', content: text } });
const bash = (cwd: string, id: string, command: string) =>
  line({
    type: 'assistant',
    cwd,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  });
/** Длинный ответ агента — балласт, раздувающий транскрипт без шагов. */
const filler = (cwd: string, index: number) =>
  line({
    type: 'assistant',
    cwd,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `пояснение ${index} ${'ж'.repeat(4000)}` }],
    },
  });

describe('POST /api/project-tests/draft/from-chat', () => {
  let project = '';
  let foreign = '';
  let config = '';
  let appData = '';
  let app: FastifyInstance;

  const transcriptDir = (cwd: string): string =>
    join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

  const writeTranscript = (cwd: string, id: string, body: string): string => {
    const dir = transcriptDir(cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, body);
    return file;
  };

  beforeEach(async () => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fromchat-')));
    foreign = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fromchat-foreign-')));
    config = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fromchat-config-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fromchat-data-')));
    const store = new AppStore(appData);
    store.addProject({ id: 'p1', name: 'proj', path: project });
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: {
        paths: { root: config, appData, settings: join(config, 'settings.json') },
      },
    } as unknown as ServerContext;
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      ctx,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    for (const dir of [project, foreign, config, appData]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const fromChat = (path: string, chatId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/project-tests/draft/from-chat',
      payload: { path, chatId },
    });

  it('свой чат зарегистрированного проекта — черновик с его шагами', async () => {
    writeTranscript(
      project,
      CHAT,
      human(project, 'Проверь вход') + bash(project, 't1', 'pnpm test login'),
    );
    const response = await fromChat(project, CHAT);
    expect(response.statusCode).toBe(200);
    const { draft } = response.json<{ draft: ProjectTestDraft }>();
    expect(draft.items[0]?.testCase.steps.map((step) => step.action)).toEqual([
      'Проверь вход',
      'Выполнить: pnpm test login',
    ]);
  });

  it('Ф19: каталог не из реестра — 400, черновик на диск не пишется', async () => {
    writeTranscript(foreign, CHAT, human(foreign, 'Проверь вход'));
    const response = await fromChat(foreign, CHAT);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'draft-chat-not-registered' });
    expect(() => statSync(join(foreign, '.agent'))).toThrow();
  });

  it('Ф19: чат другого проекта — «не нашлось», как будто его нет', async () => {
    writeTranscript(foreign, FOREIGN_CHAT, human(foreign, 'Чужой разговор'));
    const response = await fromChat(project, FOREIGN_CHAT);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ messageCode: 'draft-chat-not-found' });
  });

  it('Ф19: чат из копии ветки проекта — его чат, принимается', async () => {
    const copy = `${project}-worktrees/feature`;
    mkdirSync(copy, { recursive: true });
    try {
      writeTranscript(copy, CHAT, human(copy, 'Проверь в копии'));
      const response = await fromChat(project, CHAT);
      expect(response.statusCode).toBe(200);
    } finally {
      rmSync(`${project}-worktrees`, { recursive: true, force: true });
    }
  });

  it('Ф15: транскрипт 6 МБ — шаг из середины файла в черновике есть', async () => {
    const parts = [human(project, 'Начало сценария')];
    let size = parts[0]!.length;
    let index = 0;
    // ~3 МБ балласта, шаг посередине, ещё ~3 МБ балласта, шаг в конце.
    while (size < 3 * 1024 * 1024) {
      const chunk = filler(project, index++);
      parts.push(chunk);
      size += Buffer.byteLength(chunk);
    }
    parts.push(bash(project, 'mid', 'pnpm test middle'));
    while (size < 6 * 1024 * 1024) {
      const chunk = filler(project, index++);
      parts.push(chunk);
      size += Buffer.byteLength(chunk);
    }
    parts.push(human(project, 'Конец сценария'));
    const file = writeTranscript(project, CHAT, parts.join(''));
    expect(statSync(file).size).toBeGreaterThan(FULL_READ_LIMIT);

    const response = await fromChat(project, CHAT);
    expect(response.statusCode).toBe(200);
    const actions = response
      .json<{ draft: ProjectTestDraft }>()
      .draft.items[0]?.testCase.steps.map((step) => step.action);
    expect(actions).toEqual(['Начало сценария', 'Выполнить: pnpm test middle', 'Конец сценария']);
  });
});
