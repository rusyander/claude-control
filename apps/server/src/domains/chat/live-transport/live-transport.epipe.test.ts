import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRelay } from './live-transport.ts';

/**
 * Посредник закрыл канал, а панель ещё пишет в него: ошибка записи (EPIPE / ECONNRESET)
 * приходит на сокет, а `readline` пересылает её своему Interface. Без обработчика на нём
 * это «Unhandled 'error' event» — падал весь процесс панели (`check-platform-run-env`,
 * 15.10: два прогона из трёх). Конец канала разбирает обработчик `close` сокета.
 */

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function pipeName(): string {
  const id = `agentdeck-test-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

describe('запись в закрытый посредником канал', () => {
  it('не роняет процесс: прогон закрывается как потерянный', async () => {
    const pipe = pipeName();
    let peerGone!: () => void;
    const gone = new Promise<void>((resolve) => (peerGone = resolve));
    server = createServer((socket) => {
      // Посредник принял строку и ушёл, не дочитав остальное.
      socket.once('data', () => {
        socket.destroy();
        peerGone();
      });
    });
    await new Promise<void>((resolve) => server?.listen(pipe, resolve));
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const result = await new Promise<number>((resolve) => {
        const transport = connectRelay(
          { pipe, pid: 0 },
          { line: () => {}, stderr: () => {}, close: (code) => resolve(code) },
          10_000,
        );
        transport.write('first\n');
        void gone.then(async () => {
          const chunk = `${'x'.repeat(64 * 1024)}\n`;
          for (let i = 0; i < 50; i += 1) {
            transport.write(chunk);
            await new Promise((tick) => setTimeout(tick, 2));
          }
        });
      });
      await new Promise((settle) => setTimeout(settle, 300));
      expect(result).toBe(-1);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
