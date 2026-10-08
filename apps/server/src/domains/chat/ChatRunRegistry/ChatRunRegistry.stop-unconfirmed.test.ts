import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerChatRoutes } from '../../../routes/chat-routes/chat-routes.ts';
import { ChatSession } from '../ChatSession/ChatSession.ts';
import { ChatRunRegistry, type BufferedEvent, type RunLedgerSink } from './ChatRunRegistry.ts';
import { isPidAlive, type RunLedgerEntry } from '../run-ledger/run-ledger.ts';
import { killPidTree } from '../../../lib/process-tree/process-tree.ts';

/**
 * Ревью 28.09 (F-145, повторно): «не снимать непроверенный pid» — правильно, но
 * остановка вокруг этого правила врала. Снимка процессов нет (таймаут или отказ
 * системы, F-205) — `killProcessTree` честно не трогает номер и возвращает `[]`,
 * а реестр всё равно помечал прогон остановленным и стирал запись журнала:
 * CLI продолжал работать без присмотра, его больше никто не усыновлял, а
 * человек видел «остановлено».
 *
 * Настоящие здесь процесс, `killPidTree` и проверка жизни pid; подменён только
 * снимок процессов — он и есть граница, которая отказала.
 */

class Ledger implements RunLedgerSink {
  readonly entries = new Map<string, RunLedgerEntry>();
  read(): RunLedgerEntry[] {
    return [...this.entries.values()];
  }
  upsert(entry: RunLedgerEntry): void {
    this.entries.set(entry.key, entry);
  }
  remove(key: string): void {
    this.entries.delete(key);
  }
}

const waitFor = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let child: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;

afterEach(() => {
  registry?.stopAll();
  if (child?.pid && isPidAlive(child.pid)) child.kill('SIGKILL');
  child = undefined;
});

function adoptLiveChild(snapshot: 'missing' | 'present') {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pid = child.pid!;
  const entry: RunLedgerEntry = {
    key: 'new-stop',
    sessionId: 'sess-stop',
    projectPath: '/proj',
    cwd: '/proj',
    pid,
    startedAt: Date.now(),
  };
  const ledger = new Ledger();
  ledger.upsert(entry);
  registry = new ChatRunRegistry(() => {
    throw new Error('усыновление не запускает CLI');
  });
  registry.setLedger(ledger);
  const spawnedAt = Date.now();
  expect(
    registry.adopt(entry, {
      pollMs: 20,
      // Та же остановка, что у усыновлённого прогона по умолчанию; снимка нет —
      // путь F-205 (Windows: без снимка номер со сверкой времени не трогаем).
      kill: (target) =>
        snapshot === 'missing'
          ? killPidTree(target, { spawnedAt }, { platform: 'win32', readTable: () => undefined })
          : killPidTree(target),
    }),
  ).toBe(true);
  const events: BufferedEvent['event'][] = [];
  let closed = false;
  registry.attach('new-stop', 0, {
    send: (buffered) => events.push(buffered.event),
    close: () => {
      closed = true;
    },
  });
  return { pid, ledger, events, isClosed: () => closed };
}

describe('остановка без проверенного pid (F-145)', { timeout: 20_000 }, () => {
  it('снимка нет — процесс жив: прогон не «остановлен», запись журнала на месте, человек знает', async () => {
    const { pid, ledger, events, isClosed } = adoptLiveChild('missing');

    const outcome = registry!.stopByHuman('sess-stop');

    expect(isPidAlive(pid)).toBe(true);
    // Прогон остаётся идущим: следующее «Остановить» или усыновление после
    // перезапуска доведут дело, а вкладка по-прежнему видит его в `/chat/active`.
    expect(registry!.active().map((run) => run.chatId)).toEqual(['new-stop']);
    expect(ledger.entries.has('new-stop')).toBe(true);
    expect(isClosed()).toBe(false);
    expect(outcome).toBe('unconfirmed');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        code: 'stopUnconfirmed',
        textCode: 'chat-stop-unconfirmed-notice',
      }),
    );

    // Процесс ушёл сам — опрос закрывает прогон как обычно, запись снимается.
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child!.kill('SIGKILL');
    await exited;
    await waitFor(() => registry!.active()[0]?.status === 'done');
    expect(ledger.entries.has('new-stop')).toBe(false);
    expect(isClosed()).toBe(true);
  });

  it('снимок есть — процесс снят, прогон остановлен и убран вместе с записью', async () => {
    const { pid, ledger, isClosed } = adoptLiveChild('present');
    expect(registry!.stopByHuman('sess-stop')).toBe('stopped');
    await waitFor(() => !isPidAlive(pid));
    expect(registry!.active()).toEqual([]);
    expect(ledger.entries.has('new-stop')).toBe(false);
    expect(isClosed()).toBe(true);
  });

  it('маршрут «Остановить»: 409 с кодом, а не ok — вкладка и телефон говорят человеку', async () => {
    adoptLiveChild('missing');
    const root = mkdtempSync(join(tmpdir(), 'cc-stop-unconfirmed-'));
    const app = Fastify();
    try {
      const ctx = {
        store: new AppStore(join(root, 'data')),
        location: { paths: { root, appData: join(root, 'data') } },
        backupDir: join(root, 'backups'),
      } as unknown as ServerContext;
      registerChatRoutes(app, ctx, registry!, new ChatSession(registry!, join(root, 'data')));
      await app.ready();
      const response = await app.inject({ method: 'POST', url: '/api/chat/sess-stop/stop' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'stop_unconfirmed',
        messageCode: 'chat-stop-unconfirmed',
      });
      expect(registry!.isRunning('new-stop')).toBe(true);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('прогона нет — так и сказано', () => {
    registry = new ChatRunRegistry();
    expect(registry.stopByHuman('nobody')).toBe('absent');
  });
});
