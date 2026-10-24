import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerChatSplitRoutes } from '../chat/split-routes.ts';
import { recheckDeliveredMr } from '../../domains/chat/split-recheck/split-recheck.ts';
import { registerChatRunRoutes } from '../chat/run-routes/run-routes.ts';
import { pausedGroupOf, pauseOnHumanStop } from '../chat/split-control-routes.ts';
import { ChildTells } from '../../domains/chat/child-tell/child-tell.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { conversationKeys } from '../../lib/app-store/chat-links.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import {
  DEFERRED_ASKS_FILE,
  DeferredAsks,
} from '../../domains/chat/deferred-asks/deferred-asks.ts';
import { decideDeferred, deferredAsksOf } from '../chat/deferred-routes/deferred-store.ts';

/**
 * Управление группой из хаба по HTTP (журнал 81, 89): пауза останавливает
 * прогон и держит место (живой прогон 29.09), «Запустить сейчас» упирается в
 * потолок с числами и проходит с согласием, «Стоп» в чате группы — та же пауза,
 * группа из очереди встаёт на паузу и возвращается в очередь.
 *
 * Путь настоящий: маршрут → конвейер → реестр прогонов → хранилище на диске.
 * Подменены только процесс CLI (прогон, который идёт, пока его не остановят) и
 * заведение копий git — группа запускается прямо в реестре.
 */
describe('разделение: пауза, продолжение, запуск сейчас — по HTTP', () => {
  let root: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let conveyor: SplitConveyor;
  let app: FastifyInstance;
  let resumed: { index: number; prompt: string }[];
  let ctx: ServerContext;
  const PARENT = 'родитель';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-control-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    resumed = [];
    registry = new ChatRunRegistry((): RunLike => {
      let finish = (): void => undefined;
      return {
        start: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        stop: () => finish(),
      };
    });
    store = new AppStore(join(root, 'agentdeck'));
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
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: async (record, groups): Promise<TaskSplitResult> => ({
        chats: groups.map((index) => {
          const chatId = `chat-${index}`;
          const branch = record.groups[index]?.branch ?? '';
          store.setChatLink(chatId, {
            parentChatId: record.parentChatId,
            createdAt: new Date().toISOString(),
            branch,
            groupIndex: index,
            stage: 'work',
          });
          const started = registry.start(chatId, { prompt: 'работа', cwd: root }, {});
          return {
            index,
            title: record.groups[index]?.title ?? '',
            branch,
            chatId,
            path: join(root, `copy-${index}`),
            isWorktree: true,
            started,
            prompt: 'работа',
          };
        }),
        failures: [],
      }),
      startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
      parallel: () => 1,
      resume: (group, prompt) => {
        resumed.push({ index: group.index, prompt });
        return 'sent';
      },
      log: () => undefined,
    });
    registry.setHumanStopListener(pauseOnHumanStop(store, conveyor));
    const session = new ChatSession(registry);
    app = Fastify();
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
      conveyor,
      recheckMr: (parent, index) =>
        recheckDeliveredMr(
          {
            store: {
              get: (key) => store.getSplitPlan(key),
              set: (record) => store.setSplitPlan(record),
            },
            read: async () => ({ state: 'open', threads: [] }),
            recheck: (key, at, prompt) => conveyor.recheckDelivered(key, at, prompt),
            log: () => undefined,
          },
          parent,
          index,
        ),
    });
    // Пауза держит досылку без человека — тем же вопросом, что в runtime.
    registerChatRunRoutes(app, ctx, registry, session, undefined, pausedGroupOf(store, conveyor));
    await app.ready();

    await conveyor.begin({
      parentChatId: PARENT,
      projectPath: root,
      proposal: {
        groups: [
          { title: 'Раз', branch: 'feature/one', tasks: ['первая'] },
          { title: 'Два', branch: 'feature/two', tasks: ['вторая'] },
          { title: 'Три', branch: 'feature/three', tasks: ['третья'] },
        ],
      },
      request: {},
    });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await settle();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    // Отправка в чат заводит его папку в песочнице панели — убираем за собой.
    rmSync(join(sandboxRoot(), 'chat-0'), { recursive: true, force: true });
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const group = (index: number) => store.getSplitPlan(PARENT)?.groups[index];
  const post = (path: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/chat/split/${encodeURIComponent(PARENT)}/${path}`,
      payload,
    });

  it('пауза: прогон остановлен, группа на паузе, очередь не двигается', async () => {
    expect(registry.isRunning('chat-0')).toBe(true);
    expect(group(1)?.status).toBe('pending');

    const res = await post('pause', { index: 0 });
    await settle();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ index: 0, stopped: 1, unconfirmed: 0 });
    expect(registry.isRunning('chat-0')).toBe(false);
    expect(group(0)?.status).toBe('paused');
    expect(group(1)?.status).toBe('pending');
    expect(registry.isRunning('chat-1')).toBe(false);
  });

  it('«Продолжить» — своим местом, без вопроса о потолке', async () => {
    await post('pause', { index: 0 });
    await settle();

    const res = await post('resume-paused', { index: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ index: 0, outcome: 'sent' });
    expect(resumed[0]?.index).toBe(0);
  });

  it('группа из очереди: пауза держит её, «Продолжить» — назад в очередь', async () => {
    const paused = await post('pause', { index: 1 });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ index: 1, stopped: 0, unconfirmed: 0 });
    expect(group(1)?.status).toBe('paused');

    const back = await post('resume-paused', { index: 1 });
    expect(back.json()).toEqual({ index: 1, outcome: 'queued' });
    await settle();
    // Место занято первой — вторая ждёт в очереди.
    expect(group(1)?.status).toBe('pending');
  });

  it('«Запустить сейчас» третью мимо второй: 409 без согласия, старт с ним', async () => {
    const refused = await post('start-now', { index: 2 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ messageCode: 'split-group-no-slot' });

    const forced = await post('start-now', { index: 2, force: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().chats.map((chat: { index: number }) => chat.index)).toEqual([2]);
    expect(registry.isRunning('chat-2')).toBe(true);
    expect(group(1)?.status).toBe('pending');
  });

  it('«Стоп» в чате группы — пауза группы, а не сбой', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chat/chat-0/stop' });
    await settle();
    expect(res.json()).toEqual({ ok: true });
    expect(group(0)?.status).toBe('paused');
    expect(group(1)?.status).toBe('pending');
  });

  it('«Стоп» человека держится: слово родителя группу на паузе не будит, ждёт «Продолжить» (R13)', async () => {
    // Старт прогона в чате группы снимает паузу (`onChainResumed`) — как в runtime.
    registry.setStartListener((keys) => {
      for (const key of keys) {
        const link = store.getChatLink(key);
        if (link) return conveyor.onChainResumed(link, key);
      }
    });
    const starts: string[] = [];
    const tells = new ChildTells({
      split: (keys) => conveyor.view(keys),
      aliasesOf: (chatId) => {
        const keys = conversationKeys(store.getChatLinks(), chatId);
        return keys.length > 0 ? keys : [chatId];
      },
      settingsOf: () => ({}),
      start: (input) => {
        const started = registry.start(input.chatId, { prompt: input.prompt, cwd: input.cwd }, {});
        if (started) starts.push(input.chatId);
        return { started, busy: !started };
      },
      held: pausedGroupOf(store, conveyor),
      notify: () => undefined,
      log: () => undefined,
      defer: (run) => run(),
    });

    const stop = await app.inject({ method: 'POST', url: '/api/chat/chat-0/stop' });
    expect(stop.json()).toEqual({ ok: true });
    await settle();
    expect(group(0)?.status).toBe('paused');

    // Агент-родитель кончил ход со словом остановленной группе.
    tells.parentFinished([PARENT], '```agentdeck:tell 1\nПродолжай с места остановки.\n```');
    await settle();
    expect(starts).toEqual([]);
    expect(registry.isRunning('chat-0')).toBe(false);
    expect(group(0)?.status).toBe('paused');
    // Конец хода, который «Стоп» не снял, на паузе очередь тоже не трогает.
    tells.childFinished(['chat-0']);
    expect(starts).toEqual([]);
    expect(group(0)?.status).toBe('paused');

    // Человек нажал «Продолжить»: ход идёт, по его концу слово родителя доходит.
    expect((await post('resume-paused', { index: 0 })).json()).toEqual({
      index: 0,
      outcome: 'sent',
    });
    conveyor.onChainResumed(store.getChatLink('chat-0')!, 'chat-0');
    expect(group(0)?.status).toBe('started');
    tells.childFinished(['chat-0']);
    expect(starts).toEqual(['chat-0']);
  });

  // Карточка 33 (прогон 20.10): через 3 с после «Паузы» из хаба вкладка дослала
  // ответ человека из своей очереди новым запуском — и разбудила группу.
  it('пауза держит досылку без человека: 409 group_paused; своё сообщение человека паузу снимает', async () => {
    registry.setStartListener((keys) => {
      for (const key of keys) {
        const link = store.getChatLink(key);
        if (link) return conveyor.onChainResumed(link, key);
      }
    });
    await post('pause', { index: 0 });
    await settle();
    expect(group(0)?.status).toBe('paused');

    const send = (extra: object) =>
      app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: {
          chatId: 'chat-0',
          prompt: '«Сбой провайдера» (Рекомендую)',
          projectPath: root,
          ...extra,
        },
      });
    const automatic = await send({ automatic: true });
    expect(automatic.statusCode).toBe(409);
    expect(automatic.json()).toMatchObject({
      code: 'group_paused',
      messageCode: 'run-group-paused',
    });
    expect(registry.isRunning('chat-0')).toBe(false);
    expect(group(0)?.status).toBe('paused');

    // Человек пишет группе сам — решение его: ход идёт, группа снова работает.
    void send({});
    for (let i = 0; i < 50 && !registry.isRunning('chat-0'); i += 1) await settle();
    expect(registry.isRunning('chat-0')).toBe(true);
    expect(group(0)?.status).toBe('started');
  });

  it('«Продолжить» сдавшуюся группу: место отдано — 409 с числами, с согласием — слово группе', async () => {
    const link = store.getChatLink('chat-0');
    expect(link).toBeDefined();
    conveyor.onChainEnded(link!, { status: 'failed', error: 'Not logged in · Please run /login' });
    await settle();
    expect(group(0)?.status).toBe('failed');
    // Место ушло второй — потолок 1 полон.
    expect(group(1)?.status).toBe('started');

    const refused = await post('continue-group', { index: 0 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ messageCode: 'split-group-no-slot' });

    const forced = await post('continue-group', { index: 0, force: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ index: 0, outcome: 'sent' });
    expect(resumed.at(-1)?.index).toBe(0);
    expect(resumed.at(-1)?.prompt).toContain('Not logged in · Please run /login');
  });

  /** D-n группы — той же записью, что заводит мост прав (`deferred-bridge.ts`). */
  const askOf = (index: number, command: string) =>
    deferredAsksOf(ctx).ask({
      scope: { kind: 'group', parentChatId: PARENT, groupIndex: index },
      runKeys: [`chat-${index}`],
      toolName: 'Bash',
      input: { command },
      reason: 'human gate',
    }).record.id;
  /** Запись с диска — как её прочтёт панель после перезапуска. */
  const fromDisk = () => new DeferredAsks({ file: join(root, 'agentdeck', DEFERRED_ASKS_FILE) });

  it('«Убрать» группу на паузе отзывает её D-n: на диске, после перезапуска, решить нельзя (RF-DL-10)', async () => {
    const waiting = askOf(0, 'git push');
    const allowed = askOf(0, 'npm publish');
    const other = askOf(1, 'git push');
    await decideDeferred(ctx, allowed, { behavior: 'allow', via: 'web' });
    expect((await post('pause', { index: 0 })).statusCode).toBe(200);
    await settle();

    const dropped = await post('drop-group', { index: 0 });
    expect(dropped.statusCode).toBe(200);
    expect(group(0)?.droppedAt).toBeDefined();

    const disk = fromDisk();
    expect(disk.get(waiting)).toMatchObject({ state: 'withdrawn', closedAt: expect.any(String) });
    expect(disk.get(allowed)).toMatchObject({ state: 'withdrawn', closedAt: expect.any(String) });
    // Чужая группа того же плана не тронута.
    expect(disk.get(other)?.state).toBe('waiting');
    // Разовое разрешение убранной группы не доживает ни до чего.
    expect(
      disk.consume({ kind: 'group', parentChatId: PARENT, groupIndex: 0 }, 'Bash', {
        command: 'npm publish',
      }),
    ).toBeUndefined();
    // Позднее «Разрешить» (окно, телефон, Telegram — один путь) ничего не меняет.
    const late = await decideDeferred(ctx, waiting, { behavior: 'allow', via: 'telegram' });
    expect(late?.changed).toBe(false);
    expect(fromDisk().get(waiting)?.state).toBe('withdrawn');
  });

  it('«Отменить план» отзывает D-n всех групп и держит отзыв после перезапуска (RF-DL-10)', async () => {
    const first = askOf(0, 'git push');
    const second = askOf(1, 'git push');
    expect((await post('cancel', {})).statusCode).toBe(200);
    const disk = fromDisk();
    expect(disk.get(first)?.state).toBe('withdrawn');
    expect(disk.get(second)?.state).toBe('withdrawn');
  });

  it('номер не тот — 400; группа не в том состоянии — 409 с кодом', async () => {
    expect((await post('pause', { index: -1 })).statusCode).toBe(400);
    const notQueued = await post('start-now', { index: 0 });
    expect(notQueued.statusCode).toBe(409);
    expect(notQueued.json()).toMatchObject({ messageCode: 'split-start-not-queued' });
    // Работающая группа с чатом не «оборвана до чата» и не на паузе: заводить
    // заново и убирать — нечего.
    for (const [path, code] of [
      ['restart-group', 'split-restart-not-cut'],
      ['drop-group', 'split-drop-nothing'],
      ['continue-group', 'split-continue-nothing'],
      ['recheck', 'split-recheck-nothing'],
    ] as const) {
      const refused = await post(path, { index: 0 });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ messageCode: code });
    }
  });
});
