import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { StatusChats } from '../../domains/chat/status-chats/status-chats.ts';
import { registerChatSplitRoutes } from '../../routes/chat/split-routes.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { MAX_STATUS_QUESTION } from '../../routes/chat/split-status-routes.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * «Спросить о ходе групп» (5.1 плана экономии) поверх НАСТОЯЩЕЙ сборки:
 * `createRuntime`, маршрут разделения, реестр прогонов с его резолверами
 * сводки и профиля, хранилище на диске. Подменён только процесс CLI.
 *
 * Вопрос родителю после часа тишины стоил перезаписи его кеша (160 тыс.
 * токенов): теперь он уходит в лёгкий чат, чей запуск несёт сводку групп, а не
 * историю родителя, и не тянет ни MCP-серверов, ни описаний навыков, ни
 * инструментов правки.
 */

const PARENT = 'родитель-статус';

const group = (
  index: number,
  title: string,
  status: SplitPlanRecord['groups'][number]['status'],
): SplitPlanRecord['groups'][number] => ({
  index,
  title,
  branch: `feature/g${index + 1}`,
  after: [],
  status,
  chatId: `child-${index + 1}`,
});

describe('POST /api/chat/split/:parent/status-ask', () => {
  let root: string;
  let project: string;
  let appData: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: RunOptions[];

  const ask = (question: unknown, parent = PARENT) =>
    app.inject({
      method: 'POST',
      url: `/api/chat/split/${encodeURIComponent(parent)}/status-ask`,
      payload: { question },
    });

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-status-')));
    appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(appData);
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: project,
      createdAt: '2026-10-17T00:00:00.000Z',
      order: [0, 1],
      request: {},
      proposal: { groups: [] },
      groups: [group(0, 'Вход', 'started'), group(1, 'Отчёты', 'started')],
    });
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      // Каталог со свежим Sonnet: алиас лёгкого чата обязан развернуться в него.
      models: {
        current: () => ({
          models: [
            {
              id: 'claude-sonnet-4-6',
              name: 's4',
              family: 'claude-sonnet',
              vendor: 'anthropic',
              releaseDate: '2026-02-17',
            },
            {
              id: 'claude-sonnet-5',
              name: 's5',
              family: 'claude-sonnet',
              vendor: 'anthropic',
              releaseDate: '2026-06-29',
            },
          ],
        }),
      },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');

    started = [];
    let counter = 0;
    // Единственная подмена — процесс CLI: фабрика прогонов реестра из сборки.
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        counter += 1;
        started.push(options);
        onEvent({ kind: 'text', text: 'Группы работают.' });
        onEvent({
          kind: 'done',
          costUsd: 0,
          durationMs: 1,
          sessionId: options.sessionId ?? `sess-${counter}`,
        });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;

    app = Fastify();
    // Маршруты чата — тем же вызовом, что в таблице маршрутов (`route-table.ts`):
    // через него маршрут отправки узнаёт лёгкий чат.
    registerChatRoutes(
      app,
      ctx,
      runtime.chatRuns,
      runtime.chatSession,
      (chatId) => runtime.treePause.awaitsHuman(chatId),
      (chatId) => runtime.statusChats.assignedOf(chatId),
    );
    // Теми же объектами, что в таблице маршрутов (`route-table.ts`).
    registerChatSplitRoutes(app, ctx, {
      runs: runtime.chatRuns,
      providerChats: runtime.providerChats,
      session: runtime.chatSession,
      gate: runtime.treePause,
      conveyor: runtime.splitConveyor,
      statusChats: runtime.statusChats,
      overlap: runtime.splitOverlap,
      review: runtime.splitReview,
      asks: runtime.pendingAsks,
    });
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('вопрос заводит лёгкий чат: сводка групп вместо истории родителя, без MCP, навыков и правок', async () => {
    const response = await ask('  Что с отчётами?  ');
    expect(response.statusCode).toBe(200);
    const { chatId } = response.json() as { chatId: string };
    expect(chatId).toMatch(/^new-\d+-[0-9a-f]{8}-status$/);
    await settle();

    expect(started).toHaveLength(1);
    const run = started[0]!;
    expect(run.permissionPrompt?.runId).toBe(chatId);
    expect(run.cwd).toBe(project);
    expect(run.sessionId).toBeUndefined();
    // Сводка — своей шапкой, с группами, и вопрос человека после неё.
    expect(run.prompt.startsWith('<agentdeck-children>')).toBe(true);
    expect(run.prompt).toContain('You only observe');
    expect(run.prompt).not.toContain('agentdeck:tell');
    // Состояние «идёт» сборка сверяет с живыми прогонами (WP1c) — строка группы
    // проверяется по месту, ветке и чату, а не по слову состояния.
    expect(run.prompt).toContain('1. "Вход" (branch feature/g1, chat child-1) — ');
    expect(run.prompt).toContain('2. "Отчёты" (branch feature/g2, chat child-2) — ');
    expect(run.prompt.endsWith('\n\nЧто с отчётами?')).toBe(true);
    // Лёгкий запуск: младшая модель, ни одного MCP-сервера, ни подключений claude.ai.
    // Алиас развёрнут в свежую модель семейства, как у остальных запусков (ревью A1-F5).
    expect(run.model).toBe('claude-sonnet-5');
    expect(run.effort).toBe('medium');
    expect(run.platformArgs).toContain('--strict-mcp-config');
    expect(run.platformEnv?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(run.platformMcp?.ids ?? []).toEqual([]);
    const settings = run.platformSettings as {
      permissions?: { deny?: string[] };
      skillOverrides?: Record<string, string>;
    };
    expect(settings.permissions?.deny).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'Bash']),
    );
    expect(settings.skillOverrides?.['deep-review']).toBe('name-only');
    expect(run.profileNote).toContain('no MCP servers, no edit tools and no shell');
    expect(run.permissionMode).toBe('default');
    // Не ребёнок разделения: ни строки хаба, ни дописки группы.
    expect(store.getChatLink(chatId)).toBeUndefined();
    expect(run.child).toBeFalsy();
  });

  /** Ревью B1-F14: сбой чтения навыков бросал из резолвера и отказывал в каждом старте. */
  it('навыки не читаются — лёгкий чат всё равно стартует без правок и оболочки', async () => {
    // Папка навыков, ставшая файлом: readdirSync бросает ENOTDIR.
    writeFileSync(join(root, 'skills'), 'не папка', 'utf8');
    const response = await ask('Что с входом?');
    expect(response.statusCode).toBe(200);
    await settle();
    expect(started).toHaveLength(1);
    const settings = started[0]!.platformSettings as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(expect.arrayContaining(['Edit', 'Bash']));
    expect(started[0]!.platformArgs).toContain('--strict-mcp-config');
  });

  it('навыки не читаются — группа разделения всё равно стартует, без профиля, как до него', async () => {
    store.setChatLink('child-1', {
      parentChatId: PARENT,
      createdAt: '2026-10-17T00:00:00.000Z',
      branch: 'feature/g1',
      groupIndex: 0,
      stage: 'work',
    });
    writeFileSync(join(root, 'skills'), 'не папка', 'utf8');
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'child-1', prompt: 'Продолжай', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    await settle();
    const run = started.find((item) => item.permissionPrompt?.runId === 'child-1');
    expect(run).toBeDefined();
    expect(run!.platformArgs ?? []).not.toContain('--strict-mcp-config');
  });

  it('следующий ход под настоящим ключом получает свежую сводку — и после перезапуска', async () => {
    await ask('Как дела?');
    await settle();
    expect(started[0]!.prompt).not.toContain('edits pushed');
    // Фальшивый CLI выдал первому ходу ключ `sess-1`.
    const sessionId = 'sess-1';
    // Между ходами группа закончила.
    const record = store.getSplitPlan(PARENT)!;
    record.groups[1]!.status = 'done';
    record.groups[1]!.result = { kind: 'pushed', commits: 2 };
    store.setSplitPlan(record);

    runtime.chatRuns.start(
      sessionId,
      { prompt: 'А теперь?', cwd: project, sessionId },
      { origin: 'chat', sessionId },
    );
    await settle();
    const next = started[1]!;
    expect(next.prompt).toContain('You only observe');
    expect(next.prompt).toMatch(
      /2\. "Отчёты" \(branch feature\/g2, chat child-2\) — finished;.*edits pushed, commits: 2\./,
    );
    expect(next.prompt.endsWith('\n\nА теперь?')).toBe(true);
    expect(next.prompt.match(/<agentdeck-children>/g)).toHaveLength(1);
    expect(next.platformArgs).toContain('--strict-mcp-config');
    // Запись на диске: новый процесс панели узнаёт чат под обоими ключами.
    const reread = new StatusChats(join(appData, 'status-chats.json'));
    expect(reread.parentOf([sessionId])).toBe(PARENT);
  });

  it('родитель по-прежнему получает свою сводку с `agentdeck:tell` и полный запуск', async () => {
    runtime.chatRuns.start(PARENT, { prompt: 'Как группы?', cwd: project }, { origin: 'chat' });
    await settle();
    const parent = started[0]!;
    expect(parent.prompt).toContain('agentdeck:tell');
    expect(parent.prompt).not.toContain('You only observe');
    expect(parent.platformArgs ?? []).not.toContain('--strict-mcp-config');
  });

  it('пустой вопрос — 400, чужой родитель — 404, и ни одного прогона', async () => {
    const empty = await ask('   ');
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ messageCode: 'split-question-empty' });
    const notString = await ask(42);
    expect(notString.statusCode).toBe(400);
    const foreign = await ask('Как дела?', 'нет-такого');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ messageCode: 'split-levels-missing' });
    await settle();
    expect(started).toHaveLength(0);
  });
  /**
   * Ревью A1-F3: второй ход шёл маршрутом отправки и получал инициативу панели
   * (разделить, довести до MR) — системный промпт менялся между ходами, а чат
   * только для чтения звали делить и доставлять.
   */
  it('второй ход через маршрут отправки — без дописки панели и на модели лёгкого чата', async () => {
    await ask('Как дела?');
    await settle();
    // Продолжение принимается только у разговора с транскриптом — как его оставил CLI.
    mkdirSync(join(root, 'projects', 'project'), { recursive: true });
    writeFileSync(join(root, 'projects', 'project', 'sess-1.jsonl'), '{}\n', 'utf8');
    const send = (chatId: string, sessionId?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: {
          chatId,
          prompt: 'А теперь?',
          projectPath: project,
          ...(sessionId ? { sessionId } : {}),
        },
      });
    const next = await send('sess-1', 'sess-1');
    expect(next.statusCode).toBe(200);
    await settle();
    const turn = started[1]!;
    expect(turn.appendSystemPrompt).toBeUndefined();
    expect(turn.model).toBe('claude-sonnet-5');
    expect(turn.effort).toBe('medium');
    expect(turn.platformArgs).toContain('--strict-mcp-config');
    // Контроль: обычный чат того же проекта дописку получает — проверка видит её.
    const plain = await send('обычный-чат');
    expect(plain.statusCode).toBe(200);
    await settle();
    expect(started[2]!.appendSystemPrompt).toBeTruthy();
  });

  it('длинный вопрос — 400, ключ-прототип — 404, а не 500 (ревью B1-F8, B1-F10)', async () => {
    const long = await ask('я'.repeat(MAX_STATUS_QUESTION + 1));
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ messageCode: 'split-question-too-long' });
    for (const parent of ['__proto__', 'constructor', 'toString']) {
      const response = await ask('Как дела?', parent);
      expect(response.statusCode, parent).toBe(404);
    }
    await settle();
    expect(started).toHaveLength(0);
  });

  it('разделение без групп — свой отказ, а не «разделения нет» (ревью A1-F17)', async () => {
    store.setSplitPlan({ ...store.getSplitPlan(PARENT)!, groups: [] });
    const response = await ask('Как дела?');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ messageCode: 'split-groups-missing' });
  });

  it('активен чужой CLI — 409, и Claude-флаги чужому процессу не уходят (ревью B1-F1)', async () => {
    store.updateSettings({ provider: 'codex' });
    const response = await ask('Как дела?');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'chat-send-foreign-provider' });
    await settle();
    expect(started).toHaveLength(0);
  });

  it('два вопроса в одну миллисекунду — два чата; непринятый старт записи не оставляет (ревью B1-F5)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    const first = (await ask('Первый?')).json() as { chatId: string };
    const second = (await ask('Второй?')).json() as { chatId: string };
    vi.restoreAllMocks();
    expect(first.chatId).not.toBe(second.chatId);
    await settle();
    expect(started.map((run) => run.prompt.split('\n\n').at(-1))).toEqual(['Первый?', 'Второй?']);

    const refused = vi.spyOn(runtime.chatRuns, 'start').mockReturnValue(false);
    const busy = await ask('Третий?');
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ messageCode: 'split-status-not-started' });
    const id = (refused.mock.calls[0]?.[0] ?? '') as string;
    expect(id).toMatch(/-status$/);
    expect(runtime.statusChats.parentOf([id])).toBeUndefined();

    refused.mockImplementation(() => {
      throw new Error('нет CLI');
    });
    const thrown = await ask('Четвёртый?');
    expect(thrown.statusCode).toBe(500);
    const thrownId = (refused.mock.calls[1]?.[0] ?? '') as string;
    expect(thrownId).toMatch(/-status$/);
    expect(runtime.statusChats.parentOf([thrownId])).toBeUndefined();
  });
});
