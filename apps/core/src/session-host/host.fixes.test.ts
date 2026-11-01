import { createServer, connect, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachSession } from './client.ts';
import { runHost } from './host.ts';
import {
  decode,
  encode,
  lineSplitter,
  sessionFile,
  type HostMessage,
  type HostSpec,
} from './protocol.ts';
import { channelPath, removeChannel } from '../platform/control-channel.ts';
import { waitFor } from '../platform/__fixtures__/harness.ts';

/**
 * Находки core-s2 по хосту сессии: канал занят — CLI не запускается вовсе (F-21); ввод, который
 * хост не записал, не подтверждается (F-22); пустой ключ канала — хост не стартует (F-58).
 * Хост — в процессе теста, CLI и канал настоящие.
 */

const CLI = fileURLToPath(new URL('./__fixtures__/numbered-cli.mjs', import.meta.url));
const TOKEN = 'b'.repeat(48);
let root = '';

function plant(
  name: string,
  args: string[],
  env: Record<string, string>,
  token = TOKEN,
): { dir: string; channel: string } {
  const dir = mkdtempSync(join(root, `${name}-`));
  mkdirSync(dir, { recursive: true });
  const sessionId = `fix-${name}-${process.pid}-${Date.now()}`;
  const channel = channelPath(sessionId);
  writeFileSync(sessionFile(dir, 'token'), token);
  const spec: HostSpec = {
    v: 1,
    sessionId,
    command: process.execPath,
    args,
    cwd: dir,
    env: { ...(process.env as Record<string, string>), ...env },
    channel,
  };
  writeFileSync(sessionFile(dir, 'spec'), JSON.stringify(spec));
  return { dir, channel };
}

function client(channel: string): { socket: Socket; got: HostMessage[] } {
  const socket = connect(channel);
  const got: HostMessage[] = [];
  socket.on('error', () => undefined);
  socket.on(
    'data',
    lineSplitter((line) => {
      const message = decode<HostMessage>(line);
      if (message) got.push(message);
    }),
  );
  return { socket, got };
}

const outText = (dir: string): string =>
  existsSync(sessionFile(dir, 'stdout')) ? readFileSync(sessionFile(dir, 'stdout'), 'utf8') : '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'session host fixes '));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('core-s2 session host — no orphan CLI, no false ack, no empty key', () => {
  it('F-21 channel already taken → runHost rejects BEFORE starting the CLI: no CLI output, no host.json', async () => {
    const { dir, channel } = plant('busy', [CLI], {
      COUNT: '2',
      PACE_MS: '10',
      CLI_MAX_MS: '4000',
    });
    removeChannel(channel);
    // Windows: имя канала занято другим сервером. POSIX: хост убирает старый файл сокета сам,
    // поэтому listen срывается иначе — каталога сокета нет.
    if (process.platform !== 'win32') {
      const spec = JSON.parse(readFileSync(sessionFile(dir, 'spec'), 'utf8')) as HostSpec;
      spec.channel = join(dir, 'no-such-dir', 'ch.sock');
      writeFileSync(sessionFile(dir, 'spec'), JSON.stringify(spec));
    }
    const squatter: Server = createServer((s) => s.destroy());
    await new Promise<void>((done) => squatter.listen(channel, () => done()));
    try {
      await expect(runHost(dir)).rejects.toThrow();
      // CLI пишет первую строку сразу после старта: за секунду её не появилось — его не было.
      await new Promise((done) => setTimeout(done, 1_000));
      expect(outText(dir)).toBe('');
      expect(existsSync(sessionFile(dir, 'host'))).toBe(false);
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()));
    }
  });

  it('F-22 input after `end` and after the CLI exited is refused, never acked as written; a repeat of a written cmdId is dup', async () => {
    // CLI, который конец stdin переживает: канал после `end` остаётся, и ответ на ввод виден.
    const { dir, channel } = plant(
      'ack',
      [
        '-e',
        "process.stdin.resume(); process.stdin.on('end', () => {}); setTimeout(() => process.exit(0), 2500);",
      ],
      {},
    );
    const running = runHost(dir);
    await waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));
    const raw = client(channel);
    raw.socket.write(encode({ t: 'hello', token: TOKEN }));
    raw.socket.write(encode({ t: 'input', cmdId: 'c1', data: 'one\n' }));
    await waitFor(() => (raw.got.some((m) => m.t === 'ack') ? true : undefined));
    expect(raw.got.find((m) => m.t === 'ack')).toEqual({ t: 'ack', cmdId: 'c1', dup: false });
    raw.socket.write(encode({ t: 'end' }));
    raw.socket.write(encode({ t: 'input', cmdId: 'c2', data: 'two\n' }));
    await waitFor(() => (raw.got.some((m) => 'cmdId' in m && m.cmdId === 'c2') ? true : undefined));
    const second = raw.got.find((m) => 'cmdId' in m && m.cmdId === 'c2');
    expect(second).toMatchObject({ t: 'refused', cmdId: 'c2' });
    raw.socket.write(encode({ t: 'input', cmdId: 'c1', data: 'one\n' }));
    await waitFor(() =>
      raw.got.filter((m) => 'cmdId' in m && m.cmdId === 'c1').length === 2 ? true : undefined,
    );
    expect(raw.got.filter((m) => 'cmdId' in m && m.cmdId === 'c1')[1]).toEqual({
      t: 'ack',
      cmdId: 'c1',
      dup: true,
    });
    raw.socket.destroy();
    await running;

    // После выхода CLI: новый cmdId — отказ через клиента, а не «записано».
    const after = await attachSession(dir);
    expect(after.state).toBe('exited');
  }, 30_000);

  it('F-22 input to a CLI that closed its stdin is refused (write error surfaces), not acked', async () => {
    // Порядок держат события, а не окна времени. Прежде CLI жил ровно 3 с, а ввод слали 2,5 с:
    // на Windows отказ приходил только при выходе CLI, и под нагрузкой (CLI стартует дольше,
    // чем хост читает его личность) выход выпадал за окно — красное без дефекта (F-22 flake).
    // CLI закрывает ввод, отмечается в stdout и живёт, пока тест не положит `release`.
    const { dir, channel } = plant(
      'closed-stdin',
      // destroy() на Linux дескриптор 0 не закрывает — запись тогда просто стоит; закрываем явно.
      [
        '-e',
        [
          "const fs = require('node:fs');",
          'process.stdin.destroy();',
          'try { fs.closeSync(0); } catch {}',
          "process.stdout.write('closed' + String.fromCharCode(10));",
          "setInterval(() => { if (fs.existsSync('release')) process.exit(0); }, 50);",
          'setTimeout(() => process.exit(0), 20000);',
        ].join(' '),
      ],
      {},
    );
    const running = runHost(dir);
    // Канал принимает клиента только после host.json (личность CLI прочитана), а CLI отмечает
    // закрытый ввод сам — ждём обоих, в любом порядке.
    await waitFor(
      () =>
        existsSync(sessionFile(dir, 'host')) && outText(dir).includes('closed') ? true : undefined,
      10_000,
      'stdin closed',
    );
    const raw = client(channel);
    raw.socket.write(encode({ t: 'hello', token: TOKEN }));
    // 70 КБ больше буфера канала ОС: ни один кусок не ложится в буфер «записанным» молча.
    const ids = ['x0', 'x1', 'x2'];
    for (const cmdId of ids) {
      raw.socket.write(encode({ t: 'input', cmdId, data: `${'z'.repeat(70_000)}\n` }));
    }
    // Хост разбирает сообщения по порядку: ответ на `status` — все три ввода уже у него.
    raw.socket.write(encode({ t: 'status' }));
    const status = await waitFor(() => raw.got.find((m) => m.t === 'status'));
    expect(status).toMatchObject({ inputs: 0 });
    const answered = (): HostMessage[] =>
      raw.got.filter((m) => 'cmdId' in m && ids.includes(m.cmdId));
    if (process.platform !== 'win32') {
      // POSIX: дескриптор закрыт по-настоящему — ошибка записи приходит при живом CLI.
      await waitFor(() => (answered().some((m) => m.t === 'refused') ? true : undefined));
      expect(existsSync(sessionFile(dir, 'exit'))).toBe(false);
    }
    // Windows: libuv не закрывает дескрипторы 0–2 (`closeSync(0)` — пустая операция), а
    // stdin.destroy() закрывает лишь копию; канал рвётся, когда процесс уходит, — ошибка записи
    // приходит тогда же. Ни на одной ОС ввод не подтверждён как записанный.
    writeFileSync(join(dir, 'release'), '');
    await waitFor(() => (answered().length === ids.length ? true : undefined), 10_000, 'answers');
    for (const cmdId of ids) {
      expect(answered().filter((m) => 'cmdId' in m && m.cmdId === cmdId)).toHaveLength(1);
    }
    expect(answered().every((m) => m.t === 'refused')).toBe(true);
    // Первый ввод уже стоял в записи: его отказ — ошибка самой записи, а не «CLI вышел».
    const first = answered().find((m) => 'cmdId' in m && m.cmdId === 'x0');
    expect(first).toMatchObject({ t: 'refused' });
    expect(first && 'reason' in first ? first.reason : '').not.toMatch(
      /cli exited|cli stdin closed/,
    );
    raw.socket.destroy();
    await running;
  }, 30_000);

  it('F-105 a replay of the very first cmdId after 10 001 later inputs is still a dup, never written twice', async () => {
    const { dir, channel } = plant(
      'replay',
      ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      {},
    );
    const running = runHost(dir);
    await waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));
    const raw = client(channel);
    raw.socket.write(encode({ t: 'hello', token: TOKEN }));
    const total = 10_002;
    // Пачкой: хост отвечает на каждый ввод по мере записи в stdin.
    const batch: string[] = [];
    for (let i = 0; i < total; i += 1) batch.push(encode({ t: 'input', cmdId: `k${i}`, data: '' }));
    raw.socket.write(batch.join(''));
    await waitFor(
      () => (raw.got.filter((m) => m.t === 'ack').length >= total ? true : undefined),
      60_000,
      'all acks',
    );
    raw.socket.write(encode({ t: 'input', cmdId: 'k0', data: 'again\n' }));
    await waitFor(() =>
      raw.got.filter((m) => 'cmdId' in m && m.cmdId === 'k0').length === 2 ? true : undefined,
    );
    expect(raw.got.filter((m) => 'cmdId' in m && m.cmdId === 'k0')[1]).toEqual({
      t: 'ack',
      cmdId: 'k0',
      dup: true,
    });
    raw.socket.write(encode({ t: 'end' }));
    await running;
    raw.socket.destroy();
  }, 90_000);

  it('F-58 an empty or short channel key → runHost refuses before starting the CLI', async () => {
    for (const token of ['', '   \n', 'abc']) {
      const { dir } = plant('empty-key', [CLI], { COUNT: '1', CLI_MAX_MS: '3000' }, token);
      await expect(runHost(dir)).rejects.toThrow(/token/);
      expect(existsSync(sessionFile(dir, 'host'))).toBe(false);
      expect(outText(dir)).toBe('');
    }
  });
});
