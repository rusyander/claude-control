import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { QUEUED_SEND_HEADER, QUEUED_SENDS_FILE } from '../../domains/chat/busy-send-queue.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Ответ из хаба занятому ребёнку (W3-5): вкладка родителя его прогона не
 * ведёт (отцепленная группа, прогон конвейера), и отправка упиралась в 409 —
 * ответ человека пропадал. С `queueIfBusy` сервер ставит сообщение за идущим
 * ходом и отправляет его сам, тем же маршрутом, когда ход кончится.
 *
 * Путь настоящий: HTTP-маршрут → реестр → конец хода → повторная отправка
 * через `inject`. Заглушен только процесс CLI: первый ход держим открытым.
 */
describe('маршрут отправки: очередь сервера для занятого разговора', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let prompts: string[];
  let ctx: ServerContext;
  /** Закрыть первый ход — как если бы агент дописал ответ. */
  let finishFirst: () => void;
  const CHAT = 'queue-busy-chat';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-queue-busy-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    prompts = [];
    finishFirst = () => undefined;
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        prompts.push(options.prompt);
        onEvent({ kind: 'session', sessionId: CHAT, model: '', tools: 0 });
        // Первый ход висит, пока тест его не закроет; следующие — сразу.
        if (prompts.length > 1) return Promise.resolve();
        return new Promise<void>((done) => {
          finishFirst = done;
        });
      },
      stop: () => undefined,
    }));
    ctx = {
      store: new AppStore(join(root, 'agentdeck')),
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: join(root, 'agentdeck'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    finishFirst();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(sandboxRoot(), CHAT), { recursive: true, force: true });
  });

  const send = (prompt: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: CHAT,
        prompt,
        projectPath: join(root, 'work'),
        ...extra,
      },
    });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  it('занято, без флага — прежний 409; с флагом — 202 и доставка после хода', async () => {
    // Первый ход: поток держит запрос открытым, поэтому не ждём его ответа.
    const first = send('первое');
    await until(() => prompts.length === 1 && registry.isRunning(CHAT));
    expect(registry.isRunning(CHAT)).toBe(true);

    const refused = await send('без очереди');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'run_busy' });

    const queued = await send('ответ человека', { queueIfBusy: true });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, runId: expect.any(String) });
    // До конца хода сообщение ждёт — второго старта нет.
    await new Promise((done) => setTimeout(done, 50));
    expect(prompts).toEqual(['первое']);

    finishFirst();
    await first;
    await until(() => prompts.length === 2);
    expect(prompts).toEqual(['первое', 'ответ человека']);
  });

  /**
   * Итоговое ревью 25.09 (M2): «Стоп», пауза группы и отмена плана закрывают
   * подписчиков прогона — раньше очередь принимала это за конец хода, отправляла
   * сообщение сразу, и новый прогон снимал только что поставленную паузу.
   */
  it('ход остановили — сообщение из очереди не уходит, нового прогона нет', async () => {
    void send('первое');
    await until(() => prompts.length === 1 && registry.isRunning(CHAT));
    const queued = await send('ответ человека', { queueIfBusy: true });
    expect(queued.statusCode).toBe(202);

    const stop = await app.inject({ method: 'POST', url: `/api/chat/${CHAT}/stop` });
    expect(stop.json()).toMatchObject({ ok: true });
    await new Promise((done) => setTimeout(done, 100));

    expect(prompts).toEqual(['первое']);
    expect(registry.isRunning(CHAT)).toBe(false);
  });

  /**
   * Итоговое ревью 25.09 (m7): очередь жила в памяти — перезапуск панели молча
   * терял ответ, о котором вкладка уже сказала «в очереди». Теперь она на
   * диске, снимается по доставке, а оставшееся доставляется после старта.
   */
  it('очередь на диске: запись снимается по доставке', async () => {
    const file = join(root, 'agentdeck', QUEUED_SENDS_FILE);
    const first = send('первое');
    await until(() => prompts.length === 1 && registry.isRunning(CHAT));
    await send('ответ человека', { queueIfBusy: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject([
      { chatId: CHAT, body: { prompt: 'ответ человека' } },
    ]);

    finishFirst();
    await first;
    await until(() => prompts.length === 2);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('после перезапуска оставшееся в очереди уходит само', async () => {
    const appData = join(root, 'agentdeck');
    writeFileSync(
      join(appData, QUEUED_SENDS_FILE),
      JSON.stringify([
        {
          id: 'q1',
          chatId: CHAT,
          body: { chatId: CHAT, prompt: 'пережил перезапуск', projectPath: join(root, 'work') },
          queuedAt: new Date().toISOString(),
        },
      ]),
    );
    const restarted = Fastify();
    registerChatRunRoutes(restarted, ctx, registry, new ChatSession(registry));
    await restarted.ready();

    await until(() => prompts.length === 1);
    expect(prompts).toEqual(['пережил перезапуск']);
    await restarted.close();
  });

  /**
   * Доставка из очереди уходит с маркером: читать поток некому, и ответ — 202
   * сразу, а не поток хода, державший бы доставку до конца прогона.
   */
  it('отправка с маркером очереди — 202 без потока, ход стартовал', async () => {
    prompts.push('(прошлый ход)');
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      headers: { [QUEUED_SEND_HEADER]: '1' },
      payload: { chatId: CHAT, prompt: 'из очереди', projectPath: join(root, 'work') },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ started: true, runId: CHAT });
    expect(prompts).toEqual(['(прошлый ход)', 'из очереди']);
  });

  it('свободному разговору флаг не мешает: обычный старт с потоком', async () => {
    // Заглушка держит открытым только первый ход — этот должен закрыться сразу.
    prompts.push('(прошлый ход)');
    const response = await send('сразу', { queueIfBusy: true });

    expect(response.statusCode).toBe(200);
    expect(prompts).toEqual(['(прошлый ход)', 'сразу']);
  });
});
