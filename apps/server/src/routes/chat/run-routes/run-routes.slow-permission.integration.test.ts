import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Долгий ответ на запрос прав — строка в поток ошибок сервера (журнал 26.10,
 * #g8:30: вызов группы шёл 131 с, команда — 0,07 с, а где стояла панель — не
 * восстановить). Сторож кладёт этот поток в `server.log` (`appendServerLog`).
 * Маршрут настоящий; часы Fastify (`performance.now`) сдвигаются хуком перед
 * обработчиком — ждать настоящие 10 с незачем, граница та же.
 */
describe('POST /api/chat/permission-request: долгий ответ — в журнал сервера', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  /** На сколько «шёл» ответ: столько часы прибавляют между началом и концом ответа. */
  let took = 0;
  let offset = 0;
  let warned: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-slow-permission-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    offset = 0;
    warned = [];
    // Часы стоят и идут только хуком: время ответа — ровно `took`, граница 10 с не плывёт.
    // Целое начало: дробное дало бы разность 9 999,999… вместо 10 000 (плавающая точка).
    const base = Math.floor(performance.now());
    vi.spyOn(performance, 'now').mockImplementation(() => base + offset);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });
    registry = new ChatRunRegistry((): RunLike => ({
      start: () => new Promise(() => undefined),
      stop: () => undefined,
    }));
    const ctx = {
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      store: new AppStore(join(root, 'agentdeck')),
    } as unknown as ServerContext;
    app = Fastify();
    // Отметка начала ответа ставится до хуков запроса: сдвиг здесь — время ответа.
    app.addHook('preHandler', async () => {
      offset += took;
    });
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const ask = (toolUseId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: 'ghost-run', toolName: 'Bash', input: { command: 'ls' }, toolUseId },
    });
  const slowLines = () => warned.filter((line) => line.startsWith('permission-request:'));

  it('ответ за 131 с — строка с инструментом, вызовом и секундами', async () => {
    took = 131_000;
    expect((await ask('toolu_slow')).statusCode).toBe(200);
    expect(slowLines()).toEqual(['permission-request: Bash toolu_slow answered in 131 s']);
  });

  it('ровно 10 с — уже долгий; чуть меньше — тишина', async () => {
    took = 9_999;
    await ask('toolu_fast');
    expect(slowLines()).toEqual([]);
    took = 10_000;
    await ask('toolu_edge');
    expect(slowLines()).toEqual(['permission-request: Bash toolu_edge answered in 10 s']);
  });
});
