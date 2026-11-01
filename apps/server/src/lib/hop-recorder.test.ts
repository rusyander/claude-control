import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hopVerdictOf,
  listenerPid,
  readHopRecord,
  recordHops,
  watchHops,
  type HopRecordFile,
} from './hop-recorder.mjs';

/**
 * Клиент канала надзора панели (P131): слушатель порта — без слова состояния (оно переведено
 * вместе с Windows), ответ, не доказанный токеном, — не от ядра. Разговор с настоящим ядром —
 * интеграция P131 в `apps/core`.
 */

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

const NETSTAT_RU = [
  '',
  'Активные подключения',
  '',
  '  Имя    Локальный адрес        Внешний адрес          Состояние       PID',
  '  TCP    127.0.0.1:8888         127.0.0.1:51234        УСТАНОВЛЕНО     999',
  '  TCP    127.0.0.1:8888         0.0.0.0:0              ПРОСЛУШИВАНИЕ   4321',
  '  TCP    [::1]:5178             [::]:0                 ПРОСЛУШИВАНИЕ   777',
].join('\r\n');

describe('listenerPid is locale-free', () => {
  it('finds the listener by the zero remote address, not by the LISTENING word', () => {
    const exec = () => NETSTAT_RU;
    expect(listenerPid(8888, 'win32', exec)).toBe(4321);
    expect(listenerPid(5178, 'win32', exec)).toBe(777);
    expect(listenerPid(1, 'win32', exec)).toBe(0);
    expect(listenerPid(8888, 'linux', () => '555\n')).toBe(555);
    expect(
      listenerPid(8888, 'linux', () => {
        throw new Error('no lsof');
      }),
    ).toBe(0);
  });
});

describe('recordHops trusts only a reply proven by the supervisor token', () => {
  it('no token → nothing recorded; an impostor on the channel → unproven-reply', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hop-rec-'));
    expect(await recordHops({ coreHome: home, pids: [1] })).toEqual([]);

    const path =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\hop-rec-test-${randomBytes(6).toString('hex')}`
        : join(home, 's.sock');
    // Самозванец занял имя канала: отвечает «принято», но токена ядра не знает.
    server = createServer((socket) => {
      socket.write(`${JSON.stringify({ hello: 'aa'.repeat(16) })}\n`);
      socket.once('data', () => {
        const body = JSON.stringify({ ok: true, accepted: [1], refused: [], recordedAt: 1 });
        const proof = createHmac('sha256', 'wrong').update(body).digest('hex');
        socket.end(`${JSON.stringify({ body, proof })}\n`);
      });
    });
    await new Promise<void>((done) => server?.listen(path, done));
    writeFileSync(join(home, 'supervisor-token'), 'x'.repeat(43));
    writeFileSync(
      join(home, 'procs.json'),
      JSON.stringify({ v: 1, cores: [{ supervisor: path }] }),
    );
    expect(await recordHops({ coreHome: home, pids: [1, 1, 0] })).toEqual([
      { channel: path, ok: false, code: 'unproven-reply' },
    ]);
  });
});

const TOKEN = 't'.repeat(43);
const proven = (parts: string[]) =>
  createHmac('sha256', TOKEN).update(parts.join('\n')).digest('hex');

/** Канал надзора ядра, который доказывает ответ токеном и принимает все просимые pid. */
const channelPath = (home: string, name: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\hop-watch-${name}-${randomBytes(6).toString('hex')}`
    : join(home, `${name}.sock`);

async function provenCore(
  home: string,
  name: string,
  path = channelPath(home, name),
): Promise<{ path: string; close(): Promise<void> }> {
  const core = createServer((socket) => {
    const hello = randomBytes(16).toString('hex');
    socket.write(`${JSON.stringify({ hello })}\n`);
    socket.once('data', (chunk) => {
      const ask = JSON.parse(String(chunk).trim()) as { hops: number[]; nonce: string };
      const body = JSON.stringify({ ok: true, accepted: ask.hops, refused: [], recordedAt: 1 });
      socket.end(`${JSON.stringify({ body, proof: proven(['reply', ask.nonce, body]) })}\n`);
    });
  });
  await new Promise<void>((done) => core.listen(path, done));
  return { path, close: () => new Promise<void>((done) => core.close(() => done())) };
}

async function until(
  file: string,
  ok: (r: HopRecordFile | null) => boolean,
): Promise<HopRecordFile | null> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const record = readHopRecord(file);
    if (ok(record) || Date.now() > deadline) return record;
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe('watchHops records this server to every core of the home, also to one that starts later', () => {
  it('no core yet → empty record; a core row appears → recorded; a second core later → recorded too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hop-watch-'));
    const file = join(home, 'core-hops.json');
    writeFileSync(join(home, 'supervisor-token'), TOKEN);
    const procs = (channels: string[]) =>
      writeFileSync(
        join(home, 'procs.json'),
        JSON.stringify({ v: 1, cores: channels.map((supervisor) => ({ supervisor })) }),
      );
    procs([]);
    const first = await provenCore(home, 'a');
    const second = await provenCore(home, 'b');
    const watch = watchHops({ coreHome: home, pidsOf: () => [4242, 0, 4242], file, everyMs: 25 });
    try {
      await watch.refresh();
      expect(readHopRecord(file)).toEqual({ v: 1, pids: [4242], channels: {} });
      expect(hopVerdictOf(readHopRecord(file), first.path, 4242)).toBe('pending');

      // Ядро поднялось после сторожа: его строка в procs.json — запись без нового refresh.
      procs([first.path]);
      const one = await until(file, (r) => hopVerdictOf(r, first.path, 4242) === 'recorded');
      expect(hopVerdictOf(one, first.path, 4242)).toBe('recorded');
      expect(hopVerdictOf(one, first.path, 7)).toBe('pending');

      procs([first.path, second.path]);
      const two = await until(file, (r) => hopVerdictOf(r, second.path, 4242) === 'recorded');
      expect(hopVerdictOf(two, second.path, 4242)).toBe('recorded');
      expect(hopVerdictOf(two, first.path, 4242)).toBe('recorded');
    } finally {
      watch.stop();
      await first.close();
      await second.close();
    }
  }, 30_000);

  it('a core row whose channel does not answer yet (core still booting) is asked again, not marked done', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hop-watch-late-'));
    const file = join(home, 'core-hops.json');
    writeFileSync(join(home, 'supervisor-token'), TOKEN);
    const path = channelPath(home, 'late');
    // Строка ядра уже есть, а канал ещё не слушает: так выглядит ядро в первые миллисекунды.
    writeFileSync(
      join(home, 'procs.json'),
      JSON.stringify({ v: 1, cores: [{ supervisor: path }] }),
    );
    const watch = watchHops({ coreHome: home, pidsOf: () => [4242], file, everyMs: 25 });
    let core: { close(): Promise<void> } | undefined;
    try {
      await watch.refresh();
      expect(readHopRecord(file)?.channels).toEqual({});
      core = await provenCore(home, 'late', path);
      const record = await until(file, (r) => hopVerdictOf(r, path, 4242) === 'recorded');
      expect(hopVerdictOf(record, path, 4242)).toBe('recorded');
    } finally {
      watch.stop();
      await core?.close();
    }
  }, 30_000);

  it('hopVerdictOf: a refusal for this pid is final, another pid or channel stays pending', () => {
    const record: HopRecordFile = {
      v: 1,
      pids: [10, 11],
      channels: {
        a: {
          ok: true,
          accepted: [10],
          refused: [{ pid: 11, reason: 'not-a-listener' }],
          recordedAt: 1,
        },
        b: { ok: false, code: 'unproven-reply' },
      },
    };
    expect(hopVerdictOf(record, 'a', 10)).toBe('recorded');
    expect(hopVerdictOf(record, 'a', 11)).toBe('refused');
    expect(hopVerdictOf(record, 'b', 10)).toBe('refused');
    expect(hopVerdictOf(record, 'c', 10)).toBe('pending');
    expect(hopVerdictOf(record, 'a', 12)).toBe('pending');
    expect(hopVerdictOf(null, 'a', 10)).toBe('pending');
  });
});
