import { createServer, type Server } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attachSession, readLines } from './client.ts';
import {
  encode,
  lineSplitter,
  sessionFile,
  type ExitRecord,
  type HostRecord,
  type Identity,
} from './protocol.ts';
import { channelPath, removeChannel } from '../platform/control-channel.ts';
import type { Liveness, LivenessProbe } from '../platform/process-identity.ts';

/**
 * Сторона ядра при подключении к хосту (P89, F25): каждое «не знаю» остаётся `unknown`, а
 * не хоронит сессию; мёртвый хост без исхода — `lost` с личностью CLI. Подменяются граница
 * живости (`probe`) и, где нужен ответ хоста, сам собеседник по настоящему каналу; файлы
 * сессии — настоящие.
 */

const root = mkdtempSync(join(tmpdir(), 'session client ü '));
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
  rmSync(root, { recursive: true, force: true });
});

const HOST: Identity = { pid: 101, start: 'h' };
const CHILD: Identity = { pid: 202, start: 'c' };
const EXIT: ExitRecord = { v: 1, code: 0, signal: null, stopped: false, at: 1 };

function probe(answers: Record<number, Liveness | (() => Liveness)>): LivenessProbe {
  return {
    isAlive: async (id) => {
      const answer = answers[id.pid] ?? 'dead';
      return typeof answer === 'function' ? answer() : answer;
    },
    identityOf: async () => ({ unknown: 'unused' }),
    snapshot: async () => ({ unknown: 'unused' }),
  };
}

function session(name: string, record?: Partial<HostRecord>, token = 'tok'): string {
  const dir = mkdtempSync(join(root, `${name}-`));
  writeFileSync(sessionFile(dir, 'token'), token);
  if (record) {
    const full: HostRecord = {
      v: 1,
      host: HOST,
      child: CHILD,
      channel: channelPath(`client-${name}-${process.pid}`),
      startedAt: 0,
      ...record,
    };
    writeFileSync(sessionFile(dir, 'host'), JSON.stringify(full));
  }
  return dir;
}

/** Собеседник-хост: на hello отвечает заданными строками (как есть, включая мусор). */
async function fakeHost(channel: string, reply: string): Promise<void> {
  removeChannel(channel);
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on(
      'data',
      lineSplitter(() => socket.write(reply)),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(channel, () => done()));
}

describe('P89 session client — attach outcomes', () => {
  it('P89 host.json unreadable → unknown (not lost); host liveness unknown → unknown; channel refuses → unknown naming the channel', async () => {
    const broken = session('broken');
    mkdirSync(sessionFile(broken, 'host'));
    expect(await attachSession(broken)).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/^host\.json: EISDIR/),
    });
    const blind = session('blind', {});
    expect(await attachSession(blind, { probe: probe({ [HOST.pid]: 'unknown' }) })).toEqual({
      state: 'unknown',
      reason: 'host liveness unknown',
    });
    const silent = session('silent', { channel: channelPath(`nobody-${process.pid}`) });
    expect(await attachSession(silent, { probe: probe({ [HOST.pid]: 'alive' }) })).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/^channel: /),
    });
  });

  it('P89 host dead: exit.json written meanwhile → exited; no child in the record → lost with childAlive dead; token unreadable on a live host → unknown', async () => {
    const late = session('late', {});
    const racing = probe({
      [HOST.pid]: () => {
        writeFileSync(sessionFile(late, 'exit'), JSON.stringify(EXIT));
        return 'dead';
      },
    });
    expect(await attachSession(late, { probe: racing })).toMatchObject({
      state: 'exited',
      exit: EXIT,
    });
    const orphan = session('orphan', { child: null });
    expect(await attachSession(orphan, { probe: probe({}) })).toMatchObject({
      state: 'lost',
      child: null,
      childAlive: 'dead',
    });
    const noToken = session('notoken', {});
    rmSync(sessionFile(noToken, 'token'));
    expect(await attachSession(noToken, { probe: probe({ [HOST.pid]: 'alive' }) })).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/^token: /),
    });
  });

  // 28.10 W2-B на Linux: хост дописал исход и закрыл канал, пока его ещё считали живым — стоп
  // сразу после выхода CLI получал `unknown` вместо `exited`.
  it('P89 live host whose channel fails after exit.json appeared → exited, not unknown', async () => {
    const finishing = session('finishing', { channel: channelPath(`gone-${process.pid}`) });
    const alive = probe({
      [HOST.pid]: () => {
        writeFileSync(sessionFile(finishing, 'exit'), JSON.stringify(EXIT));
        return 'alive';
      },
    });
    expect(await attachSession(finishing, { probe: alive })).toMatchObject({
      state: 'exited',
      exit: EXIT,
    });
  });

  it('P89 host answers garbage first, then welcome carrying an exit → live connection that already holds the exit; onExit fires at once', async () => {
    const channel = channelPath(`client-welcome-${process.pid}`);
    const dir = session('welcome', { channel });
    await fakeHost(
      channel,
      `not json\n${encode({ t: 'welcome', host: HOST, child: CHILD, exited: EXIT })}`,
    );
    const attached = await attachSession(dir, { probe: probe({ [HOST.pid]: 'alive' }) });
    if (attached.state !== 'live') throw new Error(JSON.stringify(attached));
    expect(attached.session.exit).toEqual(EXIT);
    const seen = await new Promise<ExitRecord>((done) => attached.session.onExit(done));
    expect(seen).toEqual(EXIT);
    attached.session.close();
  });

  it('P89 a host that never welcomes → unknown after the hello timeout, socket closed', async () => {
    const channel = channelPath(`client-mute-${process.pid}`);
    const dir = session('mute', { channel });
    await fakeHost(channel, '');
    expect(
      await attachSession(dir, { probe: probe({ [HOST.pid]: 'alive' }), helloTimeoutMs: 200 }),
    ).toEqual({ state: 'unknown', reason: 'channel: no welcome from host' });
  });
});

describe('P89 session client — replay reads', () => {
  it('P89 readLines: no file → nothing, offset kept; only an unfinished line → nothing, next stays at the offset; CRLF trimmed; maxBytes caps the read', () => {
    const dir = session('lines');
    expect(readLines(dir, 'stdout', 5)).toEqual({ lines: [], ends: [], next: 5 });
    writeFileSync(sessionFile(dir, 'stdout'), 'partial');
    expect(readLines(dir, 'stdout', 0)).toEqual({ lines: [], ends: [], next: 0 });
    writeFileSync(sessionFile(dir, 'stdout'), 'a\r\nbb\ncc\n');
    expect(readLines(dir, 'stdout', 0)).toEqual({
      lines: ['a', 'bb', 'cc'],
      ends: [3, 6, 9],
      next: 9,
    });
    expect(readLines(dir, 'stdout', 0, 4)).toEqual({ lines: ['a'], ends: [3], next: 3 });
    expect(readLines(dir, 'stdout', 9)).toEqual({ lines: [], ends: [], next: 9 });
  });
});
