import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { WAIT_RESUME_MAX } from '../../domains/chat/group-questions/group-wait.ts';
import { RBAC_WAIT_TEXT } from '../../domains/chat/group-questions/group-wait.fixture.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Группа «по плану» кончила ход ожиданием ответа, написанным ТЕКСТОМ (живой
 * случай 23.10, группа RBAC: 3 ч 41 мин простоя до ответа человека), — поверх
 * НАСТОЯЩЕЙ сборки: `createRuntime`, реестр прогонов, планировщик конца хода,
 * запись вопросов хаба, хранилище на диске, маршрут отправки. Подменён только
 * процесс CLI: он отвечает дословным концом того хода.
 */

const PARENT = 'родитель-ожидание';
const CHILD = 'чат-группы-rbac';
const SESSION = 'sess-rbac';

const SPLIT = {
  parentChatId: PARENT,
  projectPath: '',
  createdAt: '2026-10-23T00:00:00.000Z',
  order: [0],
  request: { allowEdits: true },
  proposal: { groups: [{ title: 'RBAC', tasks: ['PROJ-55'] }] },
  groups: [
    { index: 0, title: 'RBAC', branch: 'feat/rbac', after: [], status: 'running', chatId: CHILD },
  ],
} as unknown as SplitPlanRecord;

const LINK: ChatLink = {
  parentChatId: PARENT,
  createdAt: '2026-10-23T00:00:00.000Z',
  branch: 'feat/rbac',
  groupIndex: 0,
};

const AUTO = /^\[Autonomous mode\]/;

describe('сборка: ожидание ответа текстом у группы «по плану» — панель продолжает сама', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: RunOptions[];
  /** Что отвечает подменённый CLI на каждом ходе по порядку; дальше — последний. */
  let replies: string[];

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-wait-')));
    const appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(appData);
    // Копия целиком: отметки пишутся в объект группы, и общий объект нёс бы их в следующий тест.
    store.setSplitPlan({ ...structuredClone(SPLIT), projectPath: project });
    store.setChatLink(CHILD, LINK);
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
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    started = [];
    replies = [RBAC_WAIT_TEXT];
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        const text = replies[Math.min(started.length, replies.length - 1)] ?? '';
        started.push(options);
        onEvent({ kind: 'text', text });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: SESSION });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;
    app = Fastify();
    registerChatRoutes(
      app,
      ctx,
      runtime.chatRuns,
      runtime.chatSession,
      (chatId) => runtime.treePause.awaitsHuman(chatId),
      (chatId) => runtime.statusChats.assignedOf(chatId),
    );
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    await removeWhenFree(root);
  });

  /** Ход в чат группы, затем — пока панель заводит ходы сама. */
  async function send(chatId = CHILD): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId, prompt: 'Работай по плану', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    let seen = -1;
    while (seen !== started.length) {
      seen = started.length;
      await new Promise((done) => setTimeout(done, 80));
    }
  }

  const resumes = () => started.filter((options) => AUTO.test(options.prompt ?? ''));
  const notices = () => store.getSplitPlan(PARENT)?.groups[0]?.autoNotices ?? [];
  const waiting = () => runtime.pendingAsks.of([CHILD, SESSION], () => true);

  it('живой хвост RBAC: та же сессия продолжена сразу, «ждёт вас» нет, в хабе — ответ', async () => {
    replies = [RBAC_WAIT_TEXT, 'Этапы D и E сделаны.\n\nMR: https://x.example/-/merge_requests/7'];
    await send();
    expect(resumes()).toHaveLength(1);
    const resumed = resumes()[0];
    expect(resumed?.sessionId).toBe(SESSION);
    expect(resumed?.prompt).toContain('Apply your own recommendations to every open question');
    expect(resumed?.permissionPrompt?.runId).toBe(CHILD);
    expect(waiting()).toEqual([]);
    const answers = notices().filter((notice) => notice.kind === 'answer');
    expect(answers.map((notice) => notice.summary.slice(0, 20))).toEqual([
      'Оставлять блок и пис',
      'Оставлять её и сразу',
      'Кодом, как сейчас (v',
      'Только экран отказа ',
    ]);
  });

  it('то же ожидание снова: повтор с решениями поимённо, предел подряд, человеку — никогда раньше', async () => {
    await send();
    expect(resumes()).toHaveLength(WAIT_RESUME_MAX);
    expect(resumes()[1]?.prompt).toContain('1. "Чужой блок внутри карточки');
    expect(resumes()[1]?.prompt).toContain('ended waiting for an answer again');
  });

  it('«спрашивать меня» — как раньше: панель не продолжает', async () => {
    store.setSplitDefaults({ groupQuestions: 'human' });
    await send();
    expect(resumes()).toHaveLength(0);
    expect(notices().filter((notice) => notice.kind === 'answer')).toEqual([]);
  });

  it('обычный чат не группа — не продолжает', async () => {
    await send('обычный-чат');
    expect(resumes()).toHaveLength(0);
  });
});

/**
 * F-44 на сборке: воротца «Остановить всё» и отказ реестра в старте продолжения
 * доходят до `GroupWaitResume` из `createRuntime`, а не только из юнита модуля.
 */
describe('сборка: продолжение группы «по плану» — пауза дерева и отказ в старте (F-44)', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: RunOptions[];
  /** Что сделать посреди хода — до его конца (нажать «Остановить всё»). */
  let during: (() => void) | undefined;
  let reply: string;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-wait-gate-')));
    const appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(appData);
    store.setSplitPlan({ ...structuredClone(SPLIT), projectPath: project });
    store.setChatLink(CHILD, LINK);
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
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    started = [];
    during = undefined;
    reply = RBAC_WAIT_TEXT;
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        started.push(options);
        onEvent({ kind: 'text', text: started.length === 1 ? reply : 'Сделано.' });
        if (started.length === 1) during?.();
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: SESSION });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;
    app = Fastify();
    registerChatRoutes(
      app,
      ctx,
      runtime.chatRuns,
      runtime.chatSession,
      (chatId) => runtime.treePause.awaitsHuman(chatId),
      (chatId) => runtime.statusChats.assignedOf(chatId),
    );
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    await removeWhenFree(root);
  });

  async function send(): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHILD, prompt: 'Работай по плану', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    let seen = -1;
    while (seen !== started.length) {
      seen = started.length;
      await new Promise((done) => setTimeout(done, 80));
    }
  }

  const resumes = () => started.filter((options) => AUTO.test(options.prompt ?? ''));

  it('дерево остановлено, пока ход доходил: продолжение — в очередь паузы, «Продолжить всё» его заводит', async () => {
    // Прогон, которого пауза не сняла (`unconfirmed`), доходит свой ход: дерево уже стоит.
    during = () =>
      store.setTreePause({
        root: PARENT,
        at: new Date().toISOString(),
        chats: {},
        pendingStarts: [],
      });
    await send();
    expect(resumes()).toHaveLength(0);
    const pending = store.getTreePause(PARENT)?.pendingStarts ?? [];
    expect(pending.map((item) => [item.kind, item.chatId])).toEqual([['handoff', CHILD]]);
    expect(String(pending[0]?.options.prompt)).toMatch(AUTO);

    runtime.treePause.resume(PARENT);
    await new Promise((done) => setTimeout(done, 200));
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0]?.sessionId).toBe(SESSION);
  });

  it('реестр отказал в старте продолжения — конец хода идёт обычным путём: вопрос ждёт человека', async () => {
    reply = 'Этап A сделан.\n\nКакой вариант брать дальше — кэш на сервере или на клиенте?';
    const registry = runtime.chatRuns as unknown as {
      start: (chatId: string, options: RunOptions, meta: unknown) => boolean;
    };
    const real = registry.start.bind(registry);
    let refused = 0;
    registry.start = (chatId, options, meta) => {
      // Разговор уже идёт (слово человека успело раньше) — единственный отказ реестра.
      if (AUTO.test(options.prompt ?? '')) {
        refused += 1;
        return false;
      }
      return real(chatId, options, meta);
    };
    await send();
    expect(refused).toBe(1);
    expect(runtime.pendingAsks.of([CHILD, SESSION], () => true)).toEqual([
      expect.objectContaining({ kind: 'text', text: expect.stringContaining('Какой вариант') }),
    ]);
  });
});
