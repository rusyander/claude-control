import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CarryApplyAnswer, CarryPlan } from '@agentdeck/contracts/portable-carry';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { createChat, listChats, readChat } from '../../domains/provider-chat/store/store.ts';
import { registerPortabilityCarryRoutes } from './portability-carry-routes.ts';

/**
 * Счётчик прочитанных с диска разговоров. Хранилище настоящее — обёрнут только
 * вход, потому что у отбора по возрасту в маршруте ДВЕ работы, и вторая видна
 * только отсюда: не предлагать позавчерашнее умеет и `planCarry`, а не ЧИТАТЬ
 * его файл может только маршрут.
 */
const { reads } = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock('../../domains/provider-chat/store/store.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../domains/provider-chat/store/store.ts')>();
  return {
    ...real,
    readChat: (appDataDir: string, providerId: string, chatId: string) => {
      reads.push(chatId);
      return real.readChat(appDataDir, providerId, chatId);
    },
  };
});

/**
 * Перенос незакрытой работы к новому CLI на уровне маршрутов (П6.1).
 *
 * Хранилища НАСТОЯЩИЕ: разговоры чужих CLI лежат в своих `jsonl`, транскрипт
 * Claude — в каталоге проектов, файл-опора — на диске. Подменены ровно две вещи,
 * которых у теста быть не может: запуск прогона Claude и ядро задач, которое
 * заводит разговор у чужого CLI (своего исполнителя чужих CLI у панели нет).
 *
 * Проверяется не «200 в ответе», а последствия: исходный разговор остаётся
 * целым, у нового CLI появляется разговор с опорой, обе ленты об этом сказали, а
 * вторая попытка над той же нетронутой работой отказывает.
 */
describe('portability-carry: перенос незакрытой работы', () => {
  const savedEnv = { ...process.env };

  let home: string;
  let appData: string;
  let project: string;
  let store: AppStore;
  let chains: HandoffChains;
  let app: FastifyInstance;
  /** Ручки ядра: чем сервер заводит разговор у чужого CLI. */
  let core: { estimates: EstimateFields[]; commands: Array<[string, Record<string, unknown>]> };
  /** Ответ ядра на оценку: единственное, что тест вправе сломать сам. */
  let coreOk: boolean;
  let started: { chatId: string; prompt: string; cwd: string }[];
  let emitted: { chatId: string; text: string }[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-carry-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-carry-data-'));
    project = mkdtempSync(join(tmpdir(), 'cc-carry-proj-'));
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;

    // Файл-опора: без него переносить не по чему, и маршрут это скажет.
    mkdirSync(join(project, '.agent'), { recursive: true });
    writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'Состояние работы.\n', 'utf8');

    store = new AppStore(appData);
    chains = new HandoffChains();
    core = { estimates: [], commands: [] };
    started = [];
    emitted = [];
    coreOk = true;
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ['HOME', 'USERPROFILE']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const dir of [home, appData, project]) rmSync(dir, { recursive: true, force: true });
  });

  /** Поднять маршруты с активным провайдером `active`. */
  async function serve(active: string): Promise<void> {
    store.updateSettings({ provider: active });
    app = Fastify();
    registerPortabilityCarryRoutes(
      app,
      {
        store,
        backupDir: join(appData, 'backups'),
        location: { paths: { appData, root: join(home, '.claude') } },
        models: { current: () => ({ models: [] }) },
      } as unknown as ServerContext,
      {
        chains,
        runs: {
          // Прогон Claude: запуск подменён, всё остальное по пути настоящее.
          start: (chatId: string, options: { prompt: string; cwd: string }) => {
            started.push({ chatId, prompt: options.prompt, cwd: options.cwd });
            return true;
          },
          // Заметка ложится только в ИДУЩИЙ прогон; у закрытого разговора
          // Claude прогона нет, и реестр отвечает «сказать некуда».
          emitExternal: (chatId: string, event: { text: string }) => {
            emitted.push({ chatId, text: event.text });
            return false;
          },
        },
        session: { inherit: () => {}, autoModeOverride: () => undefined },
        coreChats: {
          estimate: async (fields: EstimateFields) => {
            core.estimates.push(fields);
            return coreOk
              ? {
                  ok: true,
                  taskId: `01890000-0000-7000-8000-${String(core.estimates.length).padStart(12, '0')}`,
                }
              : { ok: false, code: 'adapter-missing', message: 'у CLI нет переходника ядра' };
          },
          command: async (_taskId: string, kind: string, fields: Record<string, unknown>) => {
            core.commands.push([kind, fields]);
            return { cmdId: 'c', status: 'applied', seq: 1 } as CommandOutcome;
          },
        },
      } as never,
    );
    await app.ready();
  }

  /** Разговор чужого CLI с одной репликой человека. */
  function foreignChat(providerId: string, title: string, task: string, at = new Date()): string {
    const chat = createChat(appData, providerId, { title, workdir: project });
    const file = join(appData, 'provider-chats', providerId, `${chat?.id}.jsonl`);
    const meta = {
      kind: 'meta',
      id: chat?.id,
      providerId,
      title,
      createdAt: at.toISOString(),
      workdir: project,
    };
    writeFileSync(
      file,
      `${JSON.stringify(meta)}\n${JSON.stringify({
        kind: 'message',
        id: 'm1',
        role: 'user',
        content: task,
        at: at.toISOString(),
      })}\n`,
      'utf8',
    );
    return chat?.id as string;
  }

  /** Транскрипт Claude: разговор, который панель увидит в списке. */
  function claudeChat(sessionId: string, task = 'разбери модуль оплаты'): void {
    const dir = join(home, '.claude', 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u0',
        cwd: project,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: task },
      })}\n`,
      'utf8',
    );
  }

  async function plan(): Promise<CarryPlan> {
    const answer = await app.inject({ method: 'GET', url: '/api/portability/carry' });
    expect(answer.statusCode).toBe(200);
    return answer.json() as CarryPlan;
  }

  async function apply(keys: string[]): Promise<CarryApplyAnswer> {
    const answer = await app.inject({
      method: 'POST',
      url: '/api/portability/carry/apply',
      payload: { keys },
    });
    expect(answer.statusCode).toBe(200);
    return answer.json() as CarryApplyAnswer;
  }

  it('предлагает разговоры ЧУЖИХ провайдеров и не предлагает свои', async () => {
    const codex = foreignChat('codex', 'Переименование', 'переименуй foo в bar');
    foreignChat('gemini', 'Свой разговор', 'это разговор активного CLI');
    claudeChat('s-1');
    await serve('gemini');

    const answer = await plan();

    expect(answer.target).toBe('gemini');
    const keys = answer.candidates.map((candidate) => candidate.key);
    expect(keys).toContain(foreignChatKey('codex', codex));
    expect(keys).toContain('s-1');
    expect(keys.some((key) => key.startsWith('gemini:'))).toBe(false);
    expect(answer.candidates.every((candidate) => candidate.ready)).toBe(true);
  });

  it('разговор, которого не касались сутки, не предлагается', async () => {
    // Отбор по возрасту стоит ДВАЖДЫ: здесь, при чтении хранилища, и в
    // `planCarry`. Это не дублирование, а цена чтения (см. `sourcesFor`), и
    // сторожит эту половину только такой случай: сними её — и разговор поедет
    // читать файл, которого касались позавчера.
    const stale = foreignChat(
      'codex',
      'Позавчерашняя работа',
      'старое задание',
      new Date(Date.now() - 25 * 60 * 60 * 1000),
    );
    const fresh = foreignChat('codex', 'Сегодняшняя работа', 'свежее задание');
    await serve('gemini');

    const keys = (await plan()).candidates.map((candidate) => candidate.key);

    expect(keys).toContain(foreignChatKey('codex', fresh));
    expect(keys).not.toContain(foreignChatKey('codex', stale));
  });

  it('файл позавчерашнего разговора даже не читается', async () => {
    const stale = foreignChat(
      'codex',
      'Позавчерашняя работа',
      'старое задание',
      new Date(Date.now() - 25 * 60 * 60 * 1000),
    );
    const fresh = foreignChat('codex', 'Сегодняшняя работа', 'свежее задание');
    await serve('gemini');
    reads.length = 0;

    await plan();

    // Исходное задание лежит первой репликой переписки, и ради списка панель
    // открывает файл каждого пригодного разговора. Отбор по возрасту в маршруте
    // ровно это и окупает: снимите его — и в список поедут чтения за все
    // времена, а поймать это по ответу нельзя, он останется прежним.
    expect(reads).toContain(fresh);
    expect(reads).not.toContain(stale);
  });

  it('заводит разговор у нового CLI, а исходный оставляет целым', async () => {
    const codex = foreignChat('codex', 'Переименование', 'переименуй foo в bar');
    await serve('gemini');

    const answer = await apply([foreignChatKey('codex', codex)]);

    expect(answer.outcomes[0]).toMatchObject({ carried: true, chainDepth: 1, noticedSource: true });
    // У цели — задача ядра с этим CLI, понятным именем и заданием по опоре.
    expect(answer.outcomes[0]?.chatId).toBe('01890000-0000-7000-8000-000000000001');
    expect(core.estimates).toHaveLength(1);
    expect(core.estimates[0]).toMatchObject({
      title: 'Переименование · продолжение',
      scenario: { preset: 'chat' },
      repos: [{ path: project, baseRef: null }],
    });
    expect(core.commands.map(([kind]) => kind)).toEqual(['set-cli', 'launch']);
    expect(core.commands[0]?.[1]).toMatchObject({ adapter: 'gemini' });
    // Панель свой разговор у цели не заводит: лента разговора — журнал задачи ядра.
    expect(listChats(appData, 'gemini')).toHaveLength(0);
    expect(core.estimates[0]?.request).toContain('.agent/PROGRESS.md');
    expect(core.estimates[0]?.request).toContain('переименуй foo в bar');
    // Источник не закрыт и не изменён: реплика человека на месте, сверху легла
    // заметка о том, куда ушла работа.
    const source = readChat(appData, 'codex', codex);
    expect(source?.messages[0]?.content).toBe('переименуй foo в bar');
    expect(source?.messages.at(-1)?.role).toBe('notice');
    expect(source?.messages.at(-1)?.content).toContain('не закрыт и не изменён');
  });

  it('вторая попытка над той же нетронутой работой отказывает петлёй', async () => {
    const codex = foreignChat('codex', 'Переименование', 'переименуй foo в bar');
    await serve('gemini');
    await apply([foreignChatKey('codex', codex)]);

    const answer = await apply([foreignChatKey('codex', codex)]);

    expect(answer.outcomes[0]).toMatchObject({ carried: false, reason: 'checkpoint_unchanged' });
    // Задачи у цели не прибавилось — отказ случился ДО ядра.
    expect(core.estimates).toHaveLength(1);
  });

  it('разговор Claude переносится, но заметке в его ленту лечь некуда', async () => {
    claudeChat('s-7');
    await serve('gemini');

    const answer = await apply(['s-7']);

    expect(answer.outcomes[0]).toMatchObject({ carried: true, noticedSource: false });
    expect(emitted.map((event) => event.chatId)).toEqual(['s-7']);
    expect(core.commands.filter(([kind]) => kind === 'launch')).toHaveLength(1);
  });

  it('корневая задача разговора Claude уезжает вместе с опорой', async () => {
    // Задание лежит первой репликой транскрипта, и П6.1 обещает переносить его
    // наравне с чек-пойнтом. Без него продолжение начиналось бы с «посмотри
    // PROGRESS.md», не зная, ради чего работа шла.
    claudeChat('s-9', 'почини выгрузку счетов');
    await serve('gemini');

    await apply(['s-9']);

    expect(core.estimates[0]?.request).toContain('почини выгрузку счетов');
    // И цепочка помнит то же задание: следующее звено получит тот же текст, а
    // не прочитает транскрипт заново.
    expect(chains.rootTaskOf(['01890000-0000-7000-8000-000000000001'])).toBe(
      'почини выгрузку счетов',
    );
  });

  it('цель Claude: работа уезжает прогоном в том же каталоге', async () => {
    const codex = foreignChat('codex', 'Переименование', 'переименуй foo в bar');
    await serve('claude');

    const answer = await apply([foreignChatKey('codex', codex)]);

    expect(answer.outcomes[0]?.carried).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(project);
    expect(started[0]?.prompt).toContain('.agent/PROGRESS.md');
    expect(answer.outcomes[0]?.chatId).toBe(started[0]?.chatId);
  });

  it('ядро отказало — перенос не случился, у цели ничего не запущено', async () => {
    // Ядро не завело задачу (у CLI нет переходника, ядро не запущено). Отказ
    // назван человеку, задача не запускалась, источник цел.
    const codex = foreignChat('codex', 'Переименование', 'переименуй foo в bar');
    await serve('gemini');
    coreOk = false;

    const answer = await apply([foreignChatKey('codex', codex)]);

    expect(answer.outcomes[0]).toMatchObject({ carried: false, failure: 'run_not_started' });
    // Оценку просили — и после её отказа ни одной команды задаче.
    expect(core.estimates).toHaveLength(1);
    expect(core.commands).toEqual([]);
    // Источник не тронут: заметки о переносе, которого не было, в нём нет.
    expect(readChat(appData, 'codex', codex)?.messages).toHaveLength(1);
  });

  it('пустой выбор — отказ, а не тихий успех', async () => {
    await serve('gemini');

    const answer = await app.inject({
      method: 'POST',
      url: '/api/portability/carry/apply',
      payload: { keys: [] },
    });

    expect(answer.statusCode).toBe(400);
  });
});
