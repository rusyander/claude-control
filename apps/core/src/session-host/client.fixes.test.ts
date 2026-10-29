import { connect, createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attachSession, HostConnection, InputRefused, readLines } from './client.ts';
import {
  decode,
  encode,
  lineSplitter,
  sessionFile,
  type HostMessage,
  type HostRecord,
  type Identity,
} from './protocol.ts';
import { channelPath, removeChannel } from '../platform/control-channel.ts';
import type { Liveness, LivenessProbe } from '../platform/process-identity.ts';

/**
 * Находки core-s2 по стороне ядра: строка вывода больше окна чтения (F-20), нечитаемый
 * exit.json при мёртвом хосте (F-43), отказ хоста на hello, повтор cmdId в полёте, остановка
 * на закрытом канале (F-99), отказ хоста в записи ввода (F-22). Файлы и сокеты настоящие.
 */

const root = mkdtempSync(join(tmpdir(), 'session client fixes '));
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
  rmSync(root, { recursive: true, force: true });
});

const HOST: Identity = { pid: 101, start: 'h' };

function probe(answers: Record<number, Liveness>): LivenessProbe {
  return {
    isAlive: async (id) => answers[id.pid] ?? 'dead',
    identityOf: async () => ({ unknown: 'unused' }),
    snapshot: async () => ({ unknown: 'unused' }),
  };
}

function sessionDir(name: string, channel?: string): string {
  const dir = mkdtempSync(join(root, `${name}-`));
  writeFileSync(sessionFile(dir, 'token'), 't'.repeat(48));
  if (channel) {
    const record: HostRecord = { v: 1, host: HOST, child: null, channel, startedAt: 0 };
    writeFileSync(sessionFile(dir, 'host'), JSON.stringify(record));
  }
  return dir;
}

/** Пара сокетов: сторона ядра и «хост», которому тест диктует ответы. */
async function pair(): Promise<{ core: Socket; host: Socket; lines: string[] }> {
  const lines: string[] = [];
  let host: Socket | undefined;
  const server = createServer((s) => {
    host = s;
    s.on('error', () => undefined);
    s.on(
      'data',
      lineSplitter((line) => lines.push(line)),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as { port: number };
  const core = connect(port, '127.0.0.1');
  core.on('error', () => undefined);
  await new Promise<void>((done) => core.once('connect', () => done()));
  for (let i = 0; i < 100 && !host; i += 1) await new Promise((d) => setTimeout(d, 10));
  if (!host) throw new Error('no server side');
  return { core, host, lines };
}

/** Подключение ядра поверх сокета: сообщения хоста идут в `receive`, как у `attachSession`. */
function wire(core: Socket): HostConnection {
  const connection = new HostConnection(core);
  core.on(
    'data',
    lineSplitter((line) => {
      const message = decode<HostMessage>(line);
      if (message) connection.receive(message);
    }),
  );
  return connection;
}

describe('core-s2 session client — big lines, unreadable exit, channel edges', () => {
  it('F-20 a 1.2 MB stdout line is read whole (the window grows), the line after it follows', () => {
    const dir = sessionDir('big');
    const big = `{"type":"user","pad":"${'x'.repeat(1_200_000)}"}`;
    writeFileSync(sessionFile(dir, 'stdout'), `${big}\n{"type":"after"}\n`);
    const first = readLines(dir, 'stdout', 0);
    expect(first.lines).toEqual([big, '{"type":"after"}']);
    expect(first.next).toBe(Buffer.byteLength(big) + 1 + '{"type":"after"}\n'.length);
  });

  it('F-20 a line over the line cap is skipped as one empty line with its size; the offset moves past it', () => {
    const dir = sessionDir('huge');
    const huge = 'y'.repeat(5_000);
    writeFileSync(sessionFile(dir, 'stdout'), `${huge}\nnext\n`);
    const read = readLines(dir, 'stdout', 0, 1_024, 4_096);
    expect(read.lines).toEqual(['']);
    expect(read.oversize).toEqual([5_001]);
    expect(read.next).toBe(5_001);
    const after = readLines(dir, 'stdout', read.next, 1_024, 4_096);
    expect(after.lines).toEqual(['next']);
    // Недописанная огромная строка — ждём её конца, а не режем.
    writeFileSync(sessionFile(dir, 'stdout'), huge);
    expect(readLines(dir, 'stdout', 0, 1_024, 4_096)).toEqual({ lines: [], ends: [], next: 0 });
  });

  it('F-43 exit.json present but unreadable, host dead → unknown, never lost', async () => {
    const dir = sessionDir('bad-exit', channelPath(`fix-bad-exit-${process.pid}`));
    mkdirSync(sessionFile(dir, 'exit'));
    const outcome = await attachSession(dir, { probe: probe({ [HOST.pid]: 'dead' }) });
    expect(outcome.state).toBe('unknown');
  });

  it('F-99 a host that refuses the hello and closes → unknown at once, not after the hello timeout', async () => {
    const channel = channelPath(`fix-refuse-${process.pid}`);
    removeChannel(channel);
    const server = createServer((s) => s.destroy());
    servers.push(server);
    await new Promise<void>((done) => server.listen(channel, () => done()));
    const dir = sessionDir('refuse', channel);
    const started = Date.now();
    const outcome = await attachSession(dir, {
      probe: probe({ [HOST.pid]: 'alive' }),
      helloTimeoutMs: 4_000,
    });
    expect(outcome.state).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('F-99 the same cmdId in flight shares one outcome; F-22 a host refusal rejects with InputRefused', async () => {
    const { core, host, lines } = await pair();
    const connection = wire(core);
    const first = connection.send('c1', 'a\n');
    const second = connection.send('c1', 'a\n');
    for (let i = 0; i < 100 && lines.length === 0; i += 1)
      await new Promise((d) => setTimeout(d, 10));
    host.write(encode({ t: 'ack', cmdId: 'c1', dup: false }));
    await expect(first).resolves.toEqual({ dup: false });
    await expect(second).resolves.toEqual({ dup: false });
    const refused = connection.send('c2', 'b\n');
    host.write(encode({ t: 'refused', cmdId: 'c2', reason: 'cli stdin closed' }));
    await expect(refused).rejects.toBeInstanceOf(InputRefused);
    connection.close();
  });

  it('stopped with unknown: the doubt reaches the caller; a non-string unknown is dropped', async () => {
    const { core, host } = await pair();
    const connection = wire(core);
    const doubted = connection.stop(10);
    host.write(encode({ t: 'stopped', residual: [], unknown: 'marker sweep: down' }));
    await expect(doubted).resolves.toEqual({ residual: [], unknown: 'marker sweep: down' });
    const garbage = connection.stop(10);
    host.write(`${JSON.stringify({ t: 'stopped', residual: [], unknown: 42 })}
`);
    await expect(garbage).resolves.toEqual({ residual: [] });
    connection.close();
  });

  it('F-99 stop and end on a closed channel answer at once; a second stop waits for the first', async () => {
    const { core, host } = await pair();
    const connection = wire(core);
    const a = connection.stop(10);
    const b = connection.stop(10);
    expect(b).toBe(a);
    // Старый формат (без `unknown`) читается как прежде — доказанная остановка.
    host.write(encode({ t: 'stopped', residual: [] }));
    await expect(a).resolves.toEqual({ residual: [] });
    connection.close();
    await new Promise((d) => setTimeout(d, 50));
    await expect(connection.stop()).rejects.toThrow(/closed/);
    await expect(connection.send('c9', 'x\n')).rejects.toThrow(/closed/);
    expect(connection.end()).toBe(false);
  });
});
