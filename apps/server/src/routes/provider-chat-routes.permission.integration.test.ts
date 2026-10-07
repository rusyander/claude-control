import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  ProviderChatDetail,
  ProviderChatStatus,
  ProviderChatSummary,
} from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { ProviderChatRun } from '../domains/provider-chat/ProviderChatRun.ts';
import { QwenServeTurn } from '../domains/provider-chat/live/qwen-serve.ts';
import type { LiveTurn, LiveTurnOptions } from '../domains/provider-chat/live/types.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * «Разрешить правки» у чата чужого CLI через настоящие маршруты, службу, прогон
 * и живой ход `qwen serve`. Подменён только сам CLI — дочерний процесс-подделка
 * с тем же HTTP/SSE (`live/fixtures/fake-qwen-serve.mjs`): он просит разрешения
 * и печатает, какой ответ получил. С настоящим qwen тот же путь гоняет
 * `tools/qa/check-foreign-permissions.mjs`.
 */

const FIXTURE = fileURLToPath(
  new URL('../domains/provider-chat/live/fixtures/fake-qwen-serve.mjs', import.meta.url),
);

/** Живой ход, у которого запуск CLI ведёт в подделку; всё остальное — настоящее. */
function fixtureTurn(): LiveTurn {
  const turn = new QwenServeTurn();
  const spawnImpl = ((_command: string, args: string[], options: object) =>
    spawn(process.execPath, [FIXTURE, ...args], {
      ...options,
      env: { ...process.env, FAKE_MODE: 'permission' },
    })) as unknown as LiveTurnOptions['spawnImpl'];
  return {
    run: (options, onDelta, onSteerable) =>
      // Команда — сам node: имя `qwen` на Windows обернулось бы в `.cmd`.
      turn.run({ ...options, command: process.execPath, spawnImpl }, onDelta, onSteerable),
    steer: (text) => turn.steer(text),
    stop: () => turn.stop(),
  };
}

describe('чужой CLI: «Разрешить правки» и карточка разрешения через маршруты', () => {
  let root: string;
  let app: FastifyInstance;
  let chats: ProviderChatService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-pperm-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const store = new AppStore(appData);
    store.updateSettings({ provider: 'qwen' });
    chats = new ProviderChatService(() => {
      const real = new ProviderChatRun();
      return {
        start: (options, onEvent) =>
          real.start({ ...options, detect: () => true, liveTurn: fixtureTurn }, onEvent),
        stop: () => real.stop(),
        steer: (text) => real.steer(text),
      };
    });
    app = Fastify();
    registerProviderChatRoutes(
      app,
      {
        location: { paths: { root, appData } },
        store,
        models: { current: () => ({ models: [] }) },
        backupDir: join(appData, 'backups'),
      } as unknown as ServerContext,
      chats,
      new HandoffChains(),
    );
    await app.ready();
  });

  afterEach(async () => {
    chats.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const status = async (id: string): Promise<ProviderChatStatus> =>
    (
      await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${id}/status` })
    ).json<ProviderChatStatus>();

  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < 200; i += 1) {
      const value = await probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('не дождались');
  }

  async function startChat(patch?: { allowEdits: boolean }): Promise<string> {
    const chat = (
      await app.inject({ method: 'POST', url: '/api/provider-chat/chats', payload: {} })
    ).json<ProviderChatSummary>();
    if (patch) {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/provider-chat/chats/${chat.id}`,
        payload: patch,
      });
      expect(patched.json<ProviderChatSummary>().allowEdits).toBe(patch.allowEdits);
    }
    const sent = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'запиши файл' },
    });
    expect(sent.statusCode).toBe(200);
    return chat.id;
  }

  async function reply(id: string): Promise<string> {
    await until(async () => !(await status(id)).isRunning || undefined);
    const detail = (
      await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${id}` })
    ).json<ProviderChatDetail>();
    return detail.messages.at(-1)?.content ?? '';
  }

  it('разговор без переключателя: карточка в статусе, «Разрешить» доходит до CLI', async () => {
    const id = await startChat();
    const pending = await until(async () => (await status(id)).permissions?.[0]);
    expect(pending.id).toBeTruthy();

    const answered = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/permissions/${pending.id}`,
      payload: { decision: 'allow' },
    });
    expect(answered.statusCode).toBe(200);
    expect(await reply(id)).toContain('разрешение: proceed_once');

    // Ход кончился — повторный ответ получает код, а не молчаливое «ок».
    const late = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/permissions/${pending.id}`,
      payload: { decision: 'allow' },
    });
    expect(late.statusCode).toBe(404);
    expect(late.json<{ messageCode: string }>().messageCode).toBe('foreign-permission-gone');
  });

  it('«Отклонить» доходит до CLI отказом', async () => {
    const id = await startChat({ allowEdits: false });
    const pending = await until(async () => (await status(id)).permissions?.[0]);
    await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/permissions/${pending.id}`,
      payload: { decision: 'deny' },
    });
    const text = await reply(id);
    expect(text).toContain('разрешение:');
    expect(text).not.toContain('proceed_once');
  });

  it('переключатель включён: CLI получает «да» без карточки', async () => {
    const id = await startChat({ allowEdits: true });
    expect(await reply(id)).toContain('разрешение: proceed_once');
  });

  it('ответ без решения — 400, просьба остаётся ждать', async () => {
    const id = await startChat();
    const pending = await until(async () => (await status(id)).permissions?.[0]);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/permissions/${pending.id}`,
      payload: { decision: 'maybe' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await status(id)).permissions).toHaveLength(1);
  });
});
