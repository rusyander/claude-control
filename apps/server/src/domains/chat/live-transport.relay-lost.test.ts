import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRelay, isRelayLost } from './live-transport.ts';
import { exitFailure } from './ChatRunner.ts';
import { runErrorCode } from './run-errors.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Посредник пропал (убит снаружи, канал не поднялся) — лента говорит, что
 * случилось, человеческими словами. Раньше причина уходила строкой «Не удалось
 * запустить «claude.cmd»: relay closed» (живой прогон 27.09, сценарий D
 * `tools/qa/check-chat-survives-restart.mjs`), и человек читал её как поломку
 * установки, хотя разговор цел и следующий ход его продолжает.
 *
 * Канал настоящий (труба / сокет), подключение — настоящим `connectRelay`;
 * подменён только сам посредник: сервер канала, который рвёт связь.
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

async function relayThat(onClient: (socket: Socket) => void): Promise<string> {
  const pipe = pipeName();
  server = createServer(onClient);
  await new Promise<void>((resolve) => server?.listen(pipe, resolve));
  return pipe;
}

function closed(pipe: string, connectMs = 10_000, fresh = false) {
  return new Promise<{ code: number; error: Error | undefined }>((resolve) => {
    connectRelay(
      { pipe, pid: 0 },
      { line: () => {}, stderr: () => {}, close: (code, error) => resolve({ code, error }) },
      connectMs,
      { fresh },
    );
  });
}

describe('потерянный посредник — словами, а не «relay closed»', () => {
  it('связь оборвалась без кода выхода: процесс потерян, лента говорит это и несёт код', async () => {
    const pipe = await relayThat((socket) => socket.destroy());
    const { code, error } = await closed(pipe);

    expect(code).toBe(-1);
    expect(isRelayLost(error)).toBe(true);
    const failure = exitFailure('claude.cmd', { spawnError: error, code, stderr: '' }, false);
    expect(failure).toEqual({ kind: 'error', message: serverText('chat-process-lost') });
    const message = failure?.kind === 'error' ? failure.message : '';
    expect(message).not.toMatch(/relay|Не удалось запустить/i);
    expect(runErrorCode(message)).toEqual({ code: 'chat-process-lost' });
  });

  it('свежий посредник так и не поднял канал — это сбой запуска с сырой причиной, не «потерян»', async () => {
    // Посредник упал при старте (импорт, права на трубу): обещание «отправьте, и
    // он продолжится» ложно — каждая повторная отправка падает так же.
    const pipe = pipeName();
    const { code, error } = await closed(pipe, 300, true);

    expect(code).toBe(-1);
    expect(isRelayLost(error)).toBe(false);
    const failure = exitFailure('claude', { spawnError: error, code, stderr: '' }, false);
    const message = failure?.kind === 'error' ? failure.message : '';
    expect(message).toMatch(/Не удалось запустить «claude»/);
    expect(message).toContain(pipe);
    expect(runErrorCode(message)).toBeUndefined();
  });

  it('канал пережившего посредника так и не поднялся — потерянный процесс', async () => {
    const { error } = await closed(pipeName(), 300);

    expect(isRelayLost(error)).toBe(true);
    expect(exitFailure('claude', { spawnError: error, stderr: '' }, false)).toEqual({
      kind: 'error',
      message: serverText('chat-process-lost'),
    });
  });

  it('посредник назвал код выхода — это обычный выход CLI, не потеря', async () => {
    const pipe = await relayThat((socket) => {
      socket.write('{"type":"relay_exit","code":3,"stderr":"boom"}\n');
      socket.end();
    });
    const { code, error } = await closed(pipe);

    expect(code).toBe(3);
    expect(isRelayLost(error)).toBe(false);
    expect(exitFailure('claude', { code, stderr: 'boom' }, false)).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it('настоящий сбой запуска по-прежнему называется сбоем запуска', () => {
    const failure = exitFailure('claude', { spawnError: new Error('ENOENT'), stderr: '' }, false);
    expect(failure?.kind === 'error' ? failure.message : '').toMatch(/Не удалось запустить/);
    expect(runErrorCode('Не удалось запустить «claude»: ENOENT')).toBeUndefined();
  });
});

/**
 * F-185. Канал к пережившему посреднику так и не поднялся (посредник умер,
 * пока панели не было), а номер его процесса занял чужой. «Остановить» снимал
 * по номеру с `spawnedAt: Date.now()` — мигом снятия, и чужой процесс, созданный
 * раньше этого мига, сходил за свой. Процесс здесь настоящий, снятие — тоже.
 */
describe('connectRelay: снятие по номеру без канала', () => {
  it('процесс, получивший номер после подключения, не снимается', async () => {
    const { spawn } = await import('node:child_process');
    const dead = pipeName();
    let foreign: ReturnType<typeof spawn> | undefined;
    const placeholder = { pid: 0 };
    const transport = connectRelay(
      {
        pipe: dead,
        get pid() {
          return placeholder.pid;
        },
      },
      { line: () => undefined, stderr: () => undefined, close: () => undefined },
      5_000,
    );
    try {
      // Запас часов в проверке — секунда (`REUSE_SLACK_MS`): «чужой» рождается позже.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
        stdio: 'ignore',
      });
      await new Promise((resolve) => foreign?.once('spawn', resolve));
      placeholder.pid = foreign.pid ?? 0;
      transport.kill();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(foreign.exitCode).toBeNull();
      expect(foreign.signalCode).toBeNull();
    } finally {
      transport.detach();
      foreign?.kill();
    }
  }, 15_000);
});
