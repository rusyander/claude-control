import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { sandboxRoot } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Сообщение посреди хода (решение владельца 30.09): при `steer` маршрут отдаёт
 * его идущему ходу сразу — агент учтёт его на ближайшем шаге, — а не ставит в
 * очередь до конца всей работы. Не принял прогон (не живой) — прежний путь:
 * 409 или очередь сервера.
 */
describe('маршрут отправки: сообщение агенту посреди хода', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let prompts: string[];
  let steered: string[];
  let accepts: boolean;
  let finishFirst: () => void;
  const CHAT = 'steer-chat';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-steer-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    prompts = [];
    steered = [];
    accepts = true;
    finishFirst = () => undefined;
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        prompts.push(options.prompt);
        onEvent({ kind: 'session', sessionId: CHAT, model: '', tools: 0 });
        if (prompts.length > 1) return Promise.resolve();
        return new Promise<void>((done) => {
          finishFirst = done;
        });
      },
      stop: () => undefined,
      steer: (prompt) => {
        if (!accepts) return false;
        steered.push(prompt);
        return true;
      },
    }));
    const ctx = {
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
      payload: { chatId: CHAT, prompt, projectPath: join(root, 'work'), ...extra },
    });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  const steerEvents = () => {
    const seen: string[] = [];
    registry.attach(CHAT, 0, {
      send: (buffered) => {
        if (buffered.event.kind === 'steer') seen.push(buffered.event.text);
      },
      close: () => undefined,
    });
    return seen;
  };

  it('ход идёт — сообщение уходит агенту сразу: 202 steered, нового прогона нет, событие в потоке', async () => {
    void send('первое');
    await until(() => prompts.length === 1 && registry.isRunning(CHAT));

    const reply = await send('нашёл баг', { steer: true });

    expect(reply.statusCode).toBe(202);
    expect(reply.json()).toMatchObject({ steered: true, runId: expect.any(String) });
    expect(steered).toEqual(['нашёл баг']);
    expect(prompts).toEqual(['первое']);
    expect(steerEvents()).toEqual(['нашёл баг']);
  });

  it('прогон не принял — прежний путь: 409 без очереди, очередь сервера с queueIfBusy', async () => {
    void send('первое');
    await until(() => prompts.length === 1 && registry.isRunning(CHAT));
    accepts = false;

    expect((await send('не живой', { steer: true })).statusCode).toBe(409);
    const queued = await send('в очередь', { steer: true, queueIfBusy: true });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true });
    expect(steerEvents()).toEqual([]);
  });

  // Ревью PR #1: ход кончился между проверкой вкладки и сервера — новый прогон
  // здесь же, а вкладка ставила то же слово в очередь: оно уходило дважды.
  it('ход уже кончился — слово на ходу не заводит прогон: 409, решает вкладка', async () => {
    const reply = await send('поздно', { steer: true });
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toMatchObject({ messageCode: 'run-steer-ended' });
    expect(prompts).toEqual([]);
  });

  it('с вложением — не на ходу: картинка идёт своим ходом', async () => {
    void send('первое');
    await until(() => prompts.length === 1 && registry.isRunning(CHAT));

    const reply = await send('смотри', {
      steer: true,
      files: [{ name: 'a.png', base64: 'iVBORw0KGgo=' }],
    });

    expect(reply.statusCode).toBe(409);
    expect(steered).toEqual([]);
  });
});
