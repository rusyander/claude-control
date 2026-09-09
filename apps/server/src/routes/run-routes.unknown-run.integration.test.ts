import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatRoutes } from './chat-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { RUN_UNKNOWN_DENIED } from '../domains/chat/run-ledger.ts';

/**
 * Запрос прав от прогона, которого реестр не знает.
 *
 * Так выглядит перезапуск панели глазами агента: его процесс жив, `PERM_RUN_ID`
 * прежний, а реестр пустой. Раньше ответ был «Разговор не найден» — ни причины,
 * ни действия; теперь отказ говорит, что случилось и что делать, и тот же текст
 * уезжает в транскрипт результатом вызова — оттуда его показывает лента.
 */
describe('POST /api/chat/permission-request: прогон не в реестре', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-unknown-run-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    registry = new ChatRunRegistry((): RunLike => ({
      start: () => new Promise(() => undefined),
      stop: () => undefined,
    }));
    const store = new AppStore(join(root, 'agentdeck'));
    const ctx = { location: { paths: { root } }, store } as unknown as ServerContext;

    app = Fastify();
    registerChatRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const ask = (runId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId, toolName: 'Bash', input: { command: 'cp a b' }, toolUseId: 'toolu_x' },
    });

  it('неизвестный прогон получает честный отказ с действием', async () => {
    const res = await ask('ghost-run');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ behavior: 'deny', message: RUN_UNKNOWN_DENIED });
    expect(RUN_UNKNOWN_DENIED).not.toContain('Разговор не найден');
  });

  it('остановленный прогон — тот же отказ: в реестре его больше нет', async () => {
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'stopped-run', prompt: 'сделай' },
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(registry.isRunning('stopped-run')).toBe(true);
    registry.stop('stopped-run');

    const res = await ask('stopped-run');
    expect(res.json()).toEqual({ behavior: 'deny', message: RUN_UNKNOWN_DENIED });
  });
});
