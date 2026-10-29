import { connect, type Socket } from 'node:net';
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
  type ExitRecord,
  type HostMessage,
  type HostRecord,
  type HostSpec,
} from './protocol.ts';
import { channelPath } from '../platform/control-channel.ts';
import { waitFor } from '../platform/__fixtures__/harness.ts';

/**
 * Хост сессии В ПРОЦЕССЕ теста (P89): `main.ts` лишь вызывает `runHost`, а дочерний процесс
 * хоста v8-покрытие не видит — поэтому протокол канала (hello/токен, ввод с повтором cmdId,
 * status, end, stop, исход в exit.json, отказ запуска) исполняется здесь тем же кодом.
 * CLI — настоящий процесс (`numbered-cli.mjs`), канал — настоящий сокет/именованный канал.
 */

const CLI = fileURLToPath(new URL('./__fixtures__/numbered-cli.mjs', import.meta.url));
const TOKEN = 'a'.repeat(48);
let root = '';

function plantSession(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  extraDirs?: string[],
): { dir: string; channel: string } {
  const dir = mkdtempSync(join(root, `${name}-`));
  mkdirSync(dir, { recursive: true });
  const sessionId = `inproc-${name}-${process.pid}-${Date.now()}`;
  const channel = channelPath(sessionId);
  writeFileSync(sessionFile(dir, 'token'), TOKEN);
  const spec: HostSpec = {
    v: 1,
    sessionId,
    command,
    args,
    cwd: dir,
    env: { ...(process.env as Record<string, string>), ...env },
    channel,
    ...(extraDirs ? { extraDirs } : {}),
  };
  writeFileSync(sessionFile(dir, 'spec'), JSON.stringify(spec));
  return { dir, channel };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Сырой клиент канала: что пришло и закрыл ли хост соединение. */
function rawClient(channel: string): {
  socket: Socket;
  got: HostMessage[];
  closed: Promise<void>;
} {
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
  const closed = new Promise<void>((done) => socket.once('close', () => done()));
  return { socket, got, closed };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'session host inproc ü '));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('P89 session host in-process — channel protocol', () => {
  it('P89 host in-process: spec.json deleted after read; hello+status in one chunk answered; a second client replaces the first; cmdId repeat acked dup without a second input; end → CLI exits 0, exit.json + exit message, runHost resolves', async () => {
    const { dir, channel } = plantSession('proto', process.execPath, [CLI], {
      COUNT: '3',
      PACE_MS: '10',
    });
    const running = runHost(dir);
    await waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));
    expect(existsSync(sessionFile(dir, 'spec'))).toBe(false);
    const record = readJson<HostRecord>(sessionFile(dir, 'host'));
    expect(record.host.pid).toBe(process.pid);
    expect(record.child?.pid).toBeGreaterThan(0);
    expect(record.channel).toBe(channel);

    // hello и первая команда одним куском: остаток после строки hello не теряется.
    const raw = rawClient(channel);
    raw.socket.write(encode({ t: 'hello', token: TOKEN }) + encode({ t: 'status' }));
    await waitFor(() => (raw.got.some((m) => m.t === 'status') ? true : undefined));
    expect(raw.got[0]).toMatchObject({ t: 'welcome', exited: null });
    expect(raw.got.find((m) => m.t === 'status')).toEqual({
      t: 'status',
      inputs: 0,
      stdinOpen: true,
    });

    const attached = await attachSession(dir);
    if (attached.state !== 'live') throw new Error(JSON.stringify(attached));
    // Подключение одно: прежнее (умершего ядра) хост закрывает.
    await raw.closed;
    const session = attached.session;
    expect(await session.send('c1', 'hello\n')).toEqual({ dup: false });
    expect(await session.send('c1', 'hello\n')).toEqual({ dup: true });
    expect(await session.send('c2', 'world\n')).toEqual({ dup: false });

    const exited = new Promise<ExitRecord>((done) => session.onExit(done));
    session.end();
    const exit = await exited;
    await running;
    expect(exit).toMatchObject({ code: 0, stopped: false });
    expect(readJson<ExitRecord>(sessionFile(dir, 'exit'))).toMatchObject({
      code: 0,
      stopped: false,
    });
    const out = readFileSync(sessionFile(dir, 'stdout'), 'utf8').split('\n');
    expect(out.filter((l) => l === 'echo hello')).toHaveLength(1);
    expect(out.filter((l) => l === 'echo world')).toHaveLength(1);
    expect(out.filter((l) => l.startsWith('line '))).toHaveLength(3);
    expect((await attachSession(dir)).state).toBe('exited');
  }, 60_000);

  it('P89 host in-process: wrong token, a non-hello first line and an endless hello are refused (connection closed, no welcome); stop over the channel → residual [], exit.json stopped:true, runHost resolves', async () => {
    const { dir, channel } = plantSession('refuse', process.execPath, [CLI], {
      COUNT: '100000',
      PACE_MS: '20',
    });
    const running = runHost(dir);
    await waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));

    const wrong = rawClient(channel);
    wrong.socket.write(encode({ t: 'hello', token: 'b'.repeat(48) }));
    await wrong.closed;
    const shortToken = rawClient(channel);
    shortToken.socket.write(encode({ t: 'hello', token: 'a' }));
    await shortToken.closed;
    const notHello = rawClient(channel);
    notHello.socket.write(encode({ t: 'status' }));
    await notHello.closed;
    const endless = rawClient(channel);
    endless.socket.write('x'.repeat(5_000));
    await endless.closed;
    for (const client of [wrong, shortToken, notHello, endless]) expect(client.got).toEqual([]);

    const attached = await attachSession(dir);
    if (attached.state !== 'live') throw new Error(JSON.stringify(attached));
    const exited = new Promise<ExitRecord>((done) => attached.session.onExit(done));
    // Без graceMs — хост берёт свой запас (5 с); CLI на сигнал выходит сразу.
    expect(await attached.session.stop()).toEqual({ residual: [] });
    expect(await exited).toMatchObject({ stopped: true });
    await running;
    expect(readJson<ExitRecord>(sessionFile(dir, 'exit'))).toMatchObject({ stopped: true });
  }, 60_000);

  it('P89 host in-process: a non-string token is refused; garbage and unknown lines after hello are ignored; a client that left before the CLI exit does not hold the host — exit.json written, runHost resolves', async () => {
    const { dir, channel } = plantSession(
      'gone',
      process.execPath,
      [CLI],
      { COUNT: '3', PACE_MS: '10' },
      [],
    );
    const running = runHost(dir);
    await waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));
    const numeric = rawClient(channel);
    numeric.socket.write('{"t":"hello","token":42}\n');
    await numeric.closed;
    expect(numeric.got).toEqual([]);

    const raw = rawClient(channel);
    raw.socket.write(
      `${encode({ t: 'hello', token: TOKEN })}not json\n{"t":"bogus"}\n${encode({ t: 'status' })}`,
    );
    await waitFor(() => (raw.got.some((m) => m.t === 'status') ? true : undefined));
    raw.socket.write(encode({ t: 'end' }));
    await waitFor(() => (raw.got.some((m) => m.t === 'ended') ? true : undefined));
    raw.socket.destroy();
    await raw.closed;
    await running;
    expect(readJson<ExitRecord>(sessionFile(dir, 'exit'))).toMatchObject({
      code: 0,
      stopped: false,
    });
  }, 60_000);

  it('P89 host in-process: a command the platform refuses → exit.json carries the refusal, host.json has no child, spec.json gone, runHost resolves without a channel', async () => {
    const { dir } = plantSession('refused', 'no-such-cli-xyz', [], {});
    await runHost(dir);
    expect(existsSync(sessionFile(dir, 'spec'))).toBe(false);
    expect(readJson<ExitRecord>(sessionFile(dir, 'exit')).refused).toMatch(/not found/);
    expect(readJson<HostRecord>(sessionFile(dir, 'host')).child).toBeNull();
    expect((await attachSession(dir)).state).toBe('exited');
  });

  it('P89 host in-process: a CLI that exits before its identity is read → exit still recorded (code kept), runHost resolves — the host never hangs without exit.json', async () => {
    const { dir } = plantSession('fast-exit', process.execPath, ['-e', 'process.exit(3)'], {});
    const timedOut = Symbol('timeout');
    const outcome = await Promise.race([
      runHost(dir).then(() => 'resolved'),
      new Promise<symbol>((done) => setTimeout(() => done(timedOut), 15_000).unref()),
    ]);
    expect(outcome).toBe('resolved');
    expect(readJson<ExitRecord>(sessionFile(dir, 'exit'))).toMatchObject({
      code: 3,
      stopped: false,
    });
    expect((await attachSession(dir)).state).toBe('exited');
  }, 30_000);

  it('P89 host in-process: no spec.json → runHost rejects and writes no host record', async () => {
    const dir = mkdtempSync(join(root, 'nospec-'));
    writeFileSync(sessionFile(dir, 'token'), TOKEN);
    await expect(runHost(dir)).rejects.toThrow(/ENOENT/);
    expect(existsSync(sessionFile(dir, 'host'))).toBe(false);
  });
});
