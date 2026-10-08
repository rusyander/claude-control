import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRelay, RELAY_SCRIPT, type LiveTransport } from './live-transport/live-transport.ts';

/**
 * Ключ канала посредника. Имя канала видно любому процессу машины, а
 * подключившийся становился единственным клиентом: получал накопленный вывод
 * CLI и писал в его stdin — ходы агента от чужого имени. Теперь клиент — только
 * тот, чья первая строка `relay_hello` с ключом из описания запуска.
 *
 * Посредник настоящий (`live-relay.mjs`), канал настоящий, сервер — настоящий
 * `connectRelay`; подменён только CLI: эхо строк ввода. Посредник — прямой
 * ребёнок теста и снимается по своему объекту процесса, не деревом.
 */

const ECHO_CLI = [
  "process.stdout.write('READY\\n');",
  "require('readline').createInterface({ input: process.stdin })",
  "  .on('line', (line) => process.stdout.write('ECHO ' + line + '\\n'))",
  "  .on('close', () => process.exit(0));",
].join('\n');

let relay: ChildProcess | undefined;
let dir: string | undefined;
const transports: LiveTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) transport.detach();
  if (relay && relay.exitCode === null && relay.signalCode === null) relay.kill();
  relay = undefined;
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = undefined;
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pipeName(): string {
  const id = `agentdeck-hello-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

/** Поднять посредника над эхо-CLI; `token` пустой — описание старого сервера. */
async function startRelay(token: string): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'relay-hello-'));
  const pipe = pipeName();
  const spec = join(dir, 'spec.json');
  writeFileSync(
    spec,
    JSON.stringify({
      command: process.execPath,
      args: ['-e', ECHO_CLI],
      cwd: dir,
      env: process.env,
      shell: false,
      pipe,
      ...(token ? { token } : {}),
    }),
  );
  relay = spawn(process.execPath, [RELAY_SCRIPT, spec], { stdio: 'ignore', windowsHide: true });
  // Канал поднят, когда к нему можно подключиться.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const up = await new Promise<boolean>((resolve) => {
      const probe = connect(pipe);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (up) return pipe;
    await pause(50);
  }
  throw new Error('посредник не поднял канал');
}

/** Подключиться сырым сокетом, как чужой процесс: что он получит и жив ли он. */
function intrude(pipe: string, first: string): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(pipe);
    let received = '';
    socket.on('data', (chunk) => (received += chunk.toString()));
    socket.on('error', () => undefined);
    socket.once('connect', () => socket.write(first));
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ received, closed: false });
    }, 6_500);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve({ received, closed: true });
    });
  });
}

function client(pipe: string, token?: string) {
  const lines: string[] = [];
  let closed = false;
  const transport = connectRelay(
    { pipe, pid: 0, ...(token ? { token } : {}) },
    {
      line: (text) => lines.push(text),
      stderr: () => {},
      close: () => {
        closed = true;
      },
    },
  );
  transports.push(transport);
  return { transport, lines, isClosed: () => closed };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('не дождались');
    await pause(25);
  }
}

describe('ключ канала посредника', () => {
  it('без приветствия с ключом — ни вывода, ни ввода; с ключом — обычный клиент', async () => {
    const token = randomBytes(16).toString('hex');
    const pipe = await startRelay(token);

    const stranger = await intrude(pipe, '{"type":"user","text":"INTRUDER"}\n');
    expect(stranger.closed).toBe(true);
    expect(stranger.received).toBe('');

    const own = client(pipe, token);
    await until(() => own.lines.includes('READY'));
    own.transport.write('hello\n');
    await until(() => own.lines.includes('ECHO hello'));
    // Строка чужого до CLI не дошла.
    expect(own.lines.some((line) => line.includes('INTRUDER'))).toBe(false);
  }, 30_000);

  it('чужой ключ не вытесняет подключённый сервер', async () => {
    const token = randomBytes(16).toString('hex');
    const pipe = await startRelay(token);
    const own = client(pipe, token);
    await until(() => own.lines.includes('READY'));

    const wrong = await intrude(
      pipe,
      `${JSON.stringify({ type: 'relay_hello', token: 'x'.repeat(token.length) })}\nINTRUDER\n`,
    );
    expect(wrong.closed).toBe(true);
    expect(wrong.received).toBe('');

    own.transport.write('still\n');
    await until(() => own.lines.includes('ECHO still'));
    expect(own.isClosed()).toBe(false);
    expect(own.lines.some((line) => line.includes('INTRUDER'))).toBe(false);
  }, 30_000);

  it('молчащий подключившийся отключается сам, по сроку приветствия', async () => {
    const pipe = await startRelay(randomBytes(16).toString('hex'));
    const silent = await intrude(pipe, '');
    expect(silent.closed).toBe(true);
    expect(silent.received).toBe('');
  }, 30_000);

  it('посредник старого сервера без ключа: новый сервер с приветствием работает, CLI его не видит', async () => {
    const pipe = await startRelay('');
    const own = client(pipe, randomBytes(16).toString('hex'));
    // «READY» здесь не ждём: без ключа клиентом стала и проба канала из
    // `startRelay` — накопленное ушло ей, как ушло бы любому подключившемуся.
    own.transport.write('compat\n');
    await until(() => own.lines.includes('ECHO compat'));
    expect(own.lines.some((line) => line.includes('relay_hello'))).toBe(false);
  }, 30_000);

  it('клиент, ушедший сразу после подключения, не роняет посредника вместе с CLI', async () => {
    // Сервер убит посреди подключения: первая же запись посредника — EPIPE.
    // Без обработчика ошибки посредник падал и уносил CLI с ходом.
    const token = randomBytes(16).toString('hex');
    const pipe = await startRelay(token);
    for (let drop = 0; drop < 3; drop += 1) {
      await new Promise<void>((resolve) => {
        const socket = connect(pipe);
        socket.on('error', () => resolve());
        socket.once('connect', () => {
          socket.write(`${JSON.stringify({ type: 'relay_hello', token })}\n`);
          socket.destroy();
          resolve();
        });
      });
      await pause(150);
    }
    expect(relay?.exitCode).toBeNull();
    const own = client(pipe, token);
    own.transport.write('alive\n');
    await until(() => own.lines.includes('ECHO alive'));
  }, 30_000);
});
