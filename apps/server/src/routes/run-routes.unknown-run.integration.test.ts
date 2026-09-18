import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatRoutes } from './chat-routes.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { MAX_AGE_MS, RunLedger, RUN_UNKNOWN_DENIED } from '../domains/chat/run-ledger.ts';

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
  let ledger: RunLedger;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-unknown-run-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    registry = new ChatRunRegistry((): RunLike => ({
      start: () => new Promise(() => undefined),
      stop: () => undefined,
    }));
    ledger = new RunLedger(join(root, 'agentdeck'));
    registry.setLedger(ledger);
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

  /**
   * Поздний подхват живого CLI, пропущенного единственным обходом при старте.
   *
   * Процесс здесь НАСТОЯЩИЙ (node, живущий минуту), журнал — настоящий файл в
   * каталоге данных, а проверки живости и образа — те самые, что стоят в
   * `adoptableEntries`. Подменить их значило бы доказать вызов функции, а не то,
   * что агент, которому раньше отказывали до конца жизни, снова работает.
   */
  describe('живой CLI, которого обход при старте не поймал', () => {
    let child: ChildProcess;

    beforeEach(() => {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], {
        stdio: 'ignore',
      });
    });

    afterEach(() => child.kill());

    const record = (startedAt: number): void =>
      ledger.upsert({
        key: 'resurrected-run',
        cwd: root,
        pid: child.pid as number,
        startedAt,
      });

    it('усыновляется прямо на запросе прав: вместо вечного отказа — решение человека', async () => {
      record(Date.now() - 1_000);

      const pending = ask('resurrected-run');
      await new Promise((done) => setTimeout(done, 60));
      // Прогон встал в реестр — карточка ушла человеку, а не отказ агенту.
      expect(registry.isRunning('resurrected-run')).toBe(true);

      const decided = await app.inject({
        method: 'POST',
        url: '/api/chat/resurrected-run/permission-decision',
        payload: { toolUseId: 'toolu_x', behavior: 'allow' },
      });
      expect(decided.statusCode).toBe(200);
      expect((await pending).json()).toMatchObject({ behavior: 'allow' });
    });

    it('запись старше суток не усыновляют: тот же отказ, правило возраста цело', async () => {
      record(Date.now() - MAX_AGE_MS - 1_000);

      const res = await ask('resurrected-run');
      expect(res.json()).toEqual({ behavior: 'deny', message: RUN_UNKNOWN_DENIED });
      expect(registry.isRunning('resurrected-run')).toBe(false);
    });

    it('мёртвый процесс из журнала — тот же отказ', async () => {
      child.kill();
      await new Promise((done) => setTimeout(done, 60));
      record(Date.now() - 1_000);

      const res = await ask('resurrected-run');
      expect(res.json()).toEqual({ behavior: 'deny', message: RUN_UNKNOWN_DENIED });
    });
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
