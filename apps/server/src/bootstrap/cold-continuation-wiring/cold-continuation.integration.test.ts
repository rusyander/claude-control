import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type {
  ChatLink,
  SplitPlanRecord,
  TreePauseRecord,
} from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import { RunRetry } from '../../domains/chat/run-retry/run-retry.ts';
import { TreePause } from '../../domains/chat/tree-pause/tree-pause.ts';
import { COLD_RESUME_INTRO, coldResumeBrief } from '../../domains/chat/split-continue.ts';
import {
  STAGE_TASK_LINE,
  withStageTask,
} from '../../domains/chat/cold-continuation/cold-continuation.ts';
import { createReviewStarter } from '../../routes/chat/review-starter.ts';
import { registerChatRunRoutes } from '../../routes/chat/run-routes/run-routes.ts';
import { wireColdContinuation } from './cold-continuation-wiring.ts';

/**
 * F-05 ревью П1, директива §L4: каждое продолжение ГРУППЫ — повтор после лимита,
 * «Продолжить всё», ответ человека, отложенный старт, слово панели — решает
 * одно правило: остывший разговор с большим окном идёт новым, со своей вводной
 * и заданием стадии. Обычный чат правило не трогает. Пути — настоящие: реестр,
 * маршрут `/api/chat/send`, пауза дерева, надзор повторов, запуск стадий; фейк
 * только сам процесс CLI.
 */

const MIN10 = 10 * 60_000;
const HOUR2 = 2 * 60 * 60_000;

interface Started {
  chatId: string;
  sessionId?: string;
  prompt: string;
}

describe('продолжение группы после остывшего кэша (F-05)', () => {
  let root: string;
  let copy: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let ctx: ServerContext;
  let app: FastifyInstance;
  let started: Started[];

  const call = (context: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 0,
          output_tokens: 10,
          cache_read_input_tokens: context,
          cache_creation_input_tokens: 0,
        },
      },
    });
  /** Транскрипт с базой 40k и последним окном 120k: выше порога база + 25k. */
  const transcript = (id: string, idleMs: number): string => {
    const dir = join(root, 'projects', 'C--copy');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${[call(40_000), call(120_000)].join('\n')}\n`, 'utf8');
    age(file, idleMs);
    return file;
  };
  const age = (file: string, idleMs: number) => {
    const at = (Date.now() - idleMs) / 1000;
    utimesSync(file, at, at);
  };
  const link = (key: string, extra: Partial<ChatLink> = {}) =>
    store.setChatLink(key, {
      parentChatId: 'parent-x',
      createdAt: new Date().toISOString(),
      ...extra,
    });
  const events = (chatId: string): ChatEvent[] => {
    const seen: ChatEvent[] = [];
    registry.attach(chatId, -1, { send: ({ event }) => seen.push(event), close: () => undefined });
    return seen;
  };
  const coldNotice = (chatId: string) =>
    events(chatId).find((event) => event.kind === 'notice' && event.code === 'coldResume');
  const last = () => started.at(-1)!;
  const retryLimit = (id: string, kind: 'limit' | 'transient') => {
    const retry = new RunRetry({
      start: (chatId, options, meta) => registry.start(chatId, options, meta),
      schedule: (run) => {
        run();
        return 1;
      },
      log: () => undefined,
    });
    retry.finished({
      chatId: id,
      sessionId: id,
      projectPath: copy,
      origin: 'groups',
      text: '',
      ok: false,
      startedAt: Date.now() - MIN10,
      contextTokens: 120_000,
      options: { prompt: 'task', cwd: copy, permissionPrompt: { runId: id } },
      ...(kind === 'limit'
        ? { limit: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) - 60 } }
        : { error: 'API Error: 529 overloaded' }),
    } as never);
  };
  const memPause = () => {
    const records = new Map<string, TreePauseRecord>();
    return {
      get: (key: string) => records.get(key),
      all: () => Object.fromEntries(records),
      set: (record: TreePauseRecord) => void records.set(record.root, record),
      clear: (key: string) => void records.delete(key),
    };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-f05-'));
    copy = mkdtempSync(join(tmpdir(), 'cc-f05-copy-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    started = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        started.push({
          chatId: options.permissionPrompt?.runId ?? '?',
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          prompt: options.prompt,
        });
        onEvent({
          kind: 'session',
          sessionId: options.sessionId ?? 'sess-new',
          model: '',
          tools: 0,
        });
        // Ход кончается сразу: маршрут отправки ждёт его конца, буфер остаётся.
        return Promise.resolve();
      },
      stop: () => undefined,
    }));
    store = new AppStore(join(root, 'agentdeck'));
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, freshOnColdResume: true } });
    ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    wireColdContinuation(registry, { store, projectsDir: () => join(root, 'projects') });
    session = new ChatSession(registry);
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  });

  it('повтор после сброса лимита идёт новым разговором даже через 10 минут простоя', () => {
    transcript('sess-l1', MIN10);
    link('sess-l1');
    retryLimit('sess-l1', 'limit');
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt.startsWith(COLD_RESUME_INTRO)).toBe(true);
    expect(coldNotice('sess-l1')).toBeDefined();
  });

  it('повтор после сбоя сети через 10 минут продолжает тёплую сессию', () => {
    transcript('sess-t1', MIN10);
    link('sess-t1');
    retryLimit('sess-t1', 'transient');
    expect(last().sessionId).toBe('sess-t1');
    expect(coldNotice('sess-t1')).toBeUndefined();
  });

  it('повтор после сбоя сети через 2 часа идёт новым разговором с заданием звена', () => {
    transcript('sess-t2', HOUR2);
    link('sess-t2', { task: 'Проверь MR !42 по замечаниям' });
    retryLimit('sess-t2', 'transient');
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt).toContain(`${STAGE_TASK_LINE}\n\nПроверь MR !42 по замечаниям`);
    expect(coldNotice('sess-t2')).toBeDefined();
  });

  it('новый разговор несёт задание звена со сжатой преамбулой окружения (живой прогон 24.10)', () => {
    // Задание до 20.10 хранило список команд подготовки целиком — 2,6 тыс. знаков в
    // каждой холодной вводной, хотя окружение давно готово.
    const install = Array.from({ length: 30 }, (_, i) => `[svc-${i}] go mod download`).join(' · ');
    transcript('sess-env', HOUR2);
    link('sess-env', {
      task: [
        'Сделай задачи группы.',
        `The panel prepared this copy: Local layer: 3 copied; dependencies installed with "${install}".`,
        'The environment is ready — do not set it up again (MCP, local layer, dependencies), start with the task right away.',
        'If a tool the task needs is missing (an MCP server, a skill, a CLI), say so in the first lines of your answer and name what it blocks — never work around it silently.',
      ].join('\n'),
    });
    retryLimit('sess-env', 'transient');
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt).toContain('Сделай задачи группы.');
    expect(last().prompt).toContain(
      "dependencies installed by the project's copy preparation (30 steps)",
    );
    expect(last().prompt).not.toContain('go mod download');
  });

  it('«Продолжить всё» после паузы дерева на 2 часа — новый разговор', () => {
    transcript('sess-p1', HOUR2);
    link('sess-p1');
    const pauses = memPause();
    const pausedAt = new Date(Date.now() - HOUR2).toISOString();
    pauses.set({
      // Корень дерева — родитель группы: пауза ставится на всё разделение.
      root: 'parent-x',
      at: pausedAt,
      chats: {
        'sess-p1': {
          cwd: copy,
          sessionId: 'sess-p1',
          options: {
            prompt: 'task',
            cwd: copy,
            sessionId: 'sess-p1',
            permissionPrompt: { runId: 'sess-p1' },
          },
          meta: { origin: 'groups', projectPath: copy, sessionId: 'sess-p1' },
          pausedAt,
        },
      },
      pendingStarts: [],
    });
    new TreePause({ links: () => store.getChatLinks(), runs: registry, store: pauses }).resume(
      'sess-p1',
    );
    expect(started).toHaveLength(1);
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt.startsWith(COLD_RESUME_INTRO)).toBe(true);
  });

  it('отложенный паузой старт решает о продолжении в момент запуска, а не откладывания', () => {
    const file = transcript('sess-d1', 0);
    link('sess-d1', { parentChatId: 'root-d1' });
    const pauses = memPause();
    pauses.set({ root: 'root-d1', at: new Date().toISOString(), chats: {}, pendingStarts: [] });
    const pause = new TreePause({
      links: () => store.getChatLinks(),
      runs: registry,
      store: pauses,
    });
    const outcome = createReviewStarter(ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
      gate: pause,
      log: { warn: () => undefined },
    } as never)({
      chatId: 'sess-d1',
      prompt: 'continue',
      cwd: copy,
      stage: 'tell',
      fromAliases: ['sess-d1'],
      resume: { sessionId: 'sess-d1' },
    });
    expect(outcome.started).toBe(true);
    expect(started).toHaveLength(0);
    age(file, HOUR2);
    pause.resume('root-d1');
    expect(started).toHaveLength(1);
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt.startsWith(COLD_RESUME_INTRO)).toBe(true);
  });

  it('ответ человека в остывший чат группы через /api/chat/send — новый разговор', async () => {
    transcript('sess-h1', HOUR2);
    link('sess-h1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'sess-h1', sessionId: 'sess-h1', prompt: 'мой ответ', projectPath: copy },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt.startsWith(COLD_RESUME_INTRO)).toBe(true);
    expect(last().prompt).toContain('мой ответ');
    expect(coldNotice('sess-h1')).toBeDefined();
  });

  it('обычный чат без группы продолжает свою сессию и через 2 часа', async () => {
    transcript('sess-plain', HOUR2);
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: 'sess-plain',
        sessionId: 'sess-plain',
        prompt: 'дальше',
        projectPath: copy,
      },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(last().sessionId).toBe('sess-plain');
    expect(coldNotice('sess-plain')).toBeUndefined();
  });

  it('тёплый чат группы продолжает свою сессию', async () => {
    transcript('sess-w1', MIN10);
    link('sess-w1');
    await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'sess-w1', sessionId: 'sess-w1', prompt: 'дальше', projectPath: copy },
    });
    expect(last().sessionId).toBe('sess-w1');
  });

  describe('дерево, заведённое до смены схемы стадий (§10 прогона 20.10)', () => {
    // Фразы задания в том виде, в каком их собирал код до 20.10.2026.
    const legacyTask = [
      "Delivering a ready MR is this group's duty.",
      "Take the group's tasks through the task delivery skill (a project variant, e.g. " +
        '`<project>-ticket-delivery`, wins over the general `ticket-delivery`; no skill — go ' +
        'through the same stages yourself): tracker tasks into work on yourself, the change.',
      'Skills: before acting, load the skill this kind of work calls for: a ticket or delivery ' +
        'to an MR → the project delivery skill (`<project>-ticket-delivery` wins over ' +
        '`ticket-delivery`); tests → unit-integration-tests.',
    ].join('\n');
    const send = (id: string, prompt: string) =>
      app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: { chatId: id, sessionId: id, prompt, projectPath: copy },
      });

    it('тёплое продолжение: первое сообщение называет ticket-delivery-2, связь переведена, строка один раз', async () => {
      transcript('sess-old-w', MIN10);
      link('sess-old-w', {
        createdAt: '2026-10-19T22:29:27.196Z',
        task: legacyTask,
        groupTask: legacyTask,
      });
      await send('sess-old-w', 'дальше');
      expect(last().sessionId).toBe('sess-old-w');
      expect(last().prompt.startsWith('Stage scheme update')).toBe(true);
      expect(last().prompt).toContain('`ticket-delivery-2`');
      expect(last().prompt.endsWith('дальше')).toBe(true);
      const stored = store.getChatLink('sess-old-w')!;
      for (const text of [stored.task!, stored.groupTask!]) {
        expect(text).not.toContain('wins over');
        expect(text).toContain('else the global `ticket-delivery-2`');
        expect(text).toContain('tracker tasks into work on yourself, the change.');
      }
      await send('sess-old-w', 'ещё');
      expect(last().prompt).toBe('ещё');
    });

    it('холодное продолжение: вводная несёт нынешнее задание без строки о смене схемы', async () => {
      transcript('sess-old-c', HOUR2);
      link('sess-old-c', { createdAt: '2026-10-19T22:29:27.196Z', task: legacyTask });
      await send('sess-old-c', 'дальше');
      expect(last().sessionId).toBeUndefined();
      expect(last().prompt).not.toContain('wins over');
      expect(last().prompt).not.toContain('Stage scheme update');
      expect(last().prompt).toContain(
        "Take the group's tasks through the delivery skill the panel group names, else the global " +
          '`ticket-delivery-2`',
      );
    });

    it('запуск стадии с вводной из старого задания — новый разговор получает её переведённой', () => {
      transcript('sess-old-r', HOUR2);
      link('sess-old-r', { createdAt: '2026-10-19T22:29:27.196Z', stage: 'review' });
      createReviewStarter(ctx, {
        runs: registry,
        providerChats: new ProviderChatService(),
        session,
        log: { warn: () => undefined },
      } as never)({
        chatId: 'sess-old-r',
        prompt: 'Опубликуй ревью.',
        cwd: copy,
        stage: 'tell',
        fromAliases: ['sess-old-r'],
        resume: { sessionId: 'sess-old-r' },
        cold: `${COLD_RESUME_INTRO}\n${STAGE_TASK_LINE}\n\n${legacyTask}`,
      });
      expect(last().sessionId).toBeUndefined();
      expect(last().prompt).not.toContain('wins over');
      expect(last().prompt).toContain('else the global `ticket-delivery-2`');
    });

    it('задание по нынешней схеме продолжение не трогает', async () => {
      transcript('sess-new-w', MIN10);
      link('sess-new-w', { task: 'Проверь MR !42' });
      await send('sess-new-w', 'дальше');
      expect(last().prompt).toBe('дальше');
      expect(store.getChatLink('sess-new-w')!.task).toBe('Проверь MR !42');
    });
  });

  it('слово панели группе, ждавшей сброса лимита, идёт новым разговором с задачами группы', () => {
    transcript('sess-g1', MIN10);
    link('sess-g1', { parentChatId: 'par-g1', groupIndex: 0, branch: 'feat/limit' });
    store.setSplitPlan({
      parentChatId: 'par-g1',
      projectPath: copy,
      createdAt: new Date().toISOString(),
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'g', tasks: ['PROJ-5 Починить экспорт'] }] },
      groups: [
        {
          index: 0,
          title: 'g',
          branch: 'feat/limit',
          chatId: 'sess-g1',
          path: copy,
          status: 'awaiting',
          waitingFor: 'limit',
        },
      ],
    } as unknown as SplitPlanRecord);
    createReviewStarter(ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
      log: { warn: () => undefined },
    } as never)({
      chatId: 'sess-g1',
      prompt: 'Group branch: feat/limit. Group tasks: PROJ-5.\n\nЛимит сброшен — продолжай.',
      cwd: copy,
      stage: 'tell',
      fromAliases: ['sess-g1'],
      resume: { sessionId: 'sess-g1' },
    });
    expect(last().sessionId).toBeUndefined();
    expect(last().prompt).toContain('Branch feat/limit');
    expect(last().prompt).toContain('- PROJ-5 Починить экспорт');
    // Ветку и ключ уже назвала вводная — строка панели их не повторяет (R3).
    expect(last().prompt).not.toContain('Group branch:');
    expect(last().prompt.endsWith('\n\nЛимит сброшен — продолжай.')).toBe(true);
    expect(coldNotice('sess-g1')).toBeDefined();
  });

  describe('строка ветки панели в новом разговоре (R3 ревью F-05)', () => {
    const IDENTITY = 'Group branch: feat/csv. Group tasks: PROJ-1.';
    const tell = (id: string, cold: string) => {
      transcript(id, HOUR2);
      link(id);
      createReviewStarter(ctx, {
        runs: registry,
        providerChats: new ProviderChatService(),
        session,
        log: { warn: () => undefined },
      } as never)({
        chatId: id,
        prompt: `${IDENTITY}\n\nПродолжай.`,
        cwd: copy,
        stage: 'tell',
        fromAliases: [id],
        resume: { sessionId: id },
        cold,
      });
      return last();
    };

    it('вводная хаба с веткой и задачами — строка не повторяется, ключ задачи остаётся', () => {
      const run = tell(
        'sess-r3a',
        coldResumeBrief({ branch: 'feat/csv' }, ['PROJ-1 Выгрузка CSV']),
      );
      expect(run.sessionId).toBeUndefined();
      expect(run.prompt).not.toContain(IDENTITY);
      expect(run.prompt).toContain('Branch feat/csv.');
      expect(run.prompt).toContain('PROJ-1');
      expect(run.prompt.endsWith('\n\nПродолжай.')).toBe(true);
    });

    it('вводная без ветки (звено ревью) строку сохраняет — иначе разговор не знал бы, где он', () => {
      // Ключ задачи в задании есть — строку держит только отсутствие ветки.
      const run = tell('sess-r3b', withStageTask(COLD_RESUME_INTRO, 'Проверь MR !42 по PROJ-1'));
      expect(run.sessionId).toBeUndefined();
      expect(run.prompt).toContain(`${IDENTITY}\n\nПродолжай.`);
    });

    it('вводная той же ветки без ключа задачи строку сохраняет — ключ нужен сторожу git', () => {
      const run = tell('sess-r3c', coldResumeBrief({ branch: 'feat/csv' }, ['Выгрузка CSV']));
      expect(run.prompt).toContain(`${IDENTITY}\n\nПродолжай.`);
    });

    // Живой прогон 25.10, группа #3: «Продолжить» собирает вводную само (`tellGroup`) из задания стадии,
    // записанного 23.10, — 2,6 тыс. знаков команд подготовки и 1,3 тыс. знаков модулей вне зоны.
    it('вводная «Продолжить» с заданием стадии — преамбула окружения сжата', () => {
      const install = Array.from({ length: 30 }, (_, i) => `[svc-${i}] go mod download`).join(
        ' · ',
      );
      const outside = Array.from({ length: 30 }, (_, i) => `svc-${i}/`).join(', ');
      const stage = [
        'Доставь MR группы.',
        `The panel prepared this copy: Local layer: 3 copied; dependencies installed with "${install}".`,
        `Outside this group's zone (not needed for its tasks): Go ready on 1.27.0 in ${outside} — run: go test ./....`,
        'The environment is ready — do not set it up again (MCP, local layer, dependencies), start with the task right away.',
        'If a tool the task needs is missing (an MCP server, a skill, a CLI), say so in the first lines of your answer and name what it blocks — never work around it silently.',
      ].join('\n');
      const run = tell(
        'sess-env-tell',
        withStageTask(coldResumeBrief({ branch: 'feat/csv' }, ['PROJ-1 Выгрузка CSV']), stage),
      );
      expect(run.sessionId).toBeUndefined();
      expect(run.prompt).toContain('Доставь MR группы.');
      expect(run.prompt).not.toContain('go mod download');
      expect(run.prompt).not.toContain('svc-7/');
      expect(run.prompt).toContain('Go ready on 1.27.0 in 30 modules — run: go test ./...');
    });
  });

  describe('копия от ветки предшественника (F-25 ревью П1)', () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: copy, stdio: ['ignore', 'pipe', 'ignore'] });
    const commit = (file: string, message: string) => {
      writeFileSync(join(copy, file), `${message}\n`);
      git('add', file);
      git('commit', '-q', '-m', message);
    };
    /** Копия: main → ветка предшественника с его коммитом → ветка группы со своим. */
    const chainCopy = () => {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      commit('a.txt', 'base');
      git('checkout', '-q', '-b', 'split/pred');
      commit('p.txt', 'pred: his work');
      git('checkout', '-q', '-b', 'split/next');
      commit('n.txt', 'next: own work');
    };

    it('хаб: вводная считает коммиты группы от ветки предшественника', () => {
      chainCopy();
      transcript('sess-b1', HOUR2);
      link('sess-b1');
      createReviewStarter(ctx, {
        runs: registry,
        providerChats: new ProviderChatService(),
        session,
        log: { warn: () => undefined },
      } as never)({
        chatId: 'sess-b1',
        prompt: 'Продолжай.',
        cwd: copy,
        stage: 'tell',
        fromAliases: ['sess-b1'],
        resume: { sessionId: 'sess-b1' },
        cold: coldResumeBrief({ branch: 'split/next' }, []),
        base: 'split/pred',
      });
      expect(last().sessionId).toBeUndefined();
      expect(last().prompt).toContain('since split/pred');
      expect(last().prompt).toContain('next: own work');
      expect(last().prompt).not.toContain('pred: his work');
    });

    it('реестр: продолжение группы с `base` в плане берёт ту же базу', async () => {
      chainCopy();
      transcript('sess-b2', HOUR2);
      link('sess-b2', { parentChatId: 'par-b2', groupIndex: 0, branch: 'split/next' });
      store.setSplitPlan({
        parentChatId: 'par-b2',
        projectPath: copy,
        createdAt: new Date().toISOString(),
        order: [0],
        request: {},
        proposal: { groups: [{ title: 'g', tasks: ['Вторая часть'] }] },
        groups: [
          {
            index: 0,
            title: 'g',
            branch: 'split/next',
            base: 'split/pred',
            chatId: 'sess-b2',
            path: copy,
            status: 'started',
          },
        ],
      } as unknown as SplitPlanRecord);
      await app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: { chatId: 'sess-b2', sessionId: 'sess-b2', prompt: 'дальше', projectPath: copy },
      });
      expect(last().sessionId).toBeUndefined();
      expect(last().prompt).toContain('since split/pred');
      expect(last().prompt).not.toContain('pred: his work');
    });
  });
});
