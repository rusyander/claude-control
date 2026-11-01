import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Сторож панели (`tools/keepalive.mjs`) пишет звенья ядру (P131, 08b) сразу, как только
 * поднятая им половина заняла порт, — не на ближайшем 20-секундном опросе. Здесь настоящий
 * сторож отдельным процессом: `pnpm` в PATH — подставной, он поднимает две «половины» на
 * свободных портах; ядро — канал надзора в этом процессе, который доказывает ответ токеном и
 * запоминает, какие pid и когда ему назвали. Дом сторожа и дом ядра — временные.
 *
 * `KA_SRC` — другой файл сторожа (прежний код для красного прогона).
 */

const SCRIPT = resolve(__dirname, '../../../..', process.env.KA_SRC ?? 'tools/keepalive.mjs');
const TOKEN = 'k'.repeat(43);
const proven = (parts: string[]) =>
  createHmac('sha256', TOKEN).update(parts.join('\n')).digest('hex');

let root = '';
let keepalive: ChildProcess | undefined;
let core: Server | undefined;

afterEach(async () => {
  keepalive?.kill();
  keepalive = undefined;
  // Половины выходят сами, когда пропал файл-пропуск: чужих процессов тест не снимает.
  if (root) rmSync(join(root, 'alive'), { force: true });
  await new Promise((done) => setTimeout(done, 800));
  await new Promise<void>((done) => (core ? core.close(() => done()) : done()));
  core = undefined;
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  root = '';
});

async function freePort(): Promise<number> {
  for (;;) {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((done) => probe.close(() => done()));
    if (port < 5170 || port > 5180) return port;
  }
}

/** Подставная половина: слушает свой порт через ~0.8 с, пишет «pid время», живёт, пока есть пропуск. */
const FAKE_HALF = `
import { createServer } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_DIR;
const filter = process.argv[process.argv.indexOf('--filter') + 1] ?? '';
const id = filter.endsWith('web') ? 'web' : 'server';
const port = Number(id === 'web' ? process.env.WEB_PORT : process.env.PORT);
setTimeout(() => {
  createServer((s) => s.end()).listen(port, '127.0.0.1', () =>
    writeFileSync(join(dir, id + '.pid'), process.pid + ' ' + Date.now()),
  );
}, 800);
setInterval(() => { if (!existsSync(join(dir, 'alive'))) process.exit(0); }, 200);
`;

type Asked = { hops: number[]; at: number };

/** Канал надзора ядра: доказывает ответ токеном, принимает всё и запоминает просьбы. */
async function provenCore(home: string, asked: Asked[]): Promise<string> {
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\keepalive-hops-${randomBytes(6).toString('hex')}`
      : join(home, 'core.sock');
  core = createServer((socket) => {
    const hello = randomBytes(16).toString('hex');
    socket.write(`${JSON.stringify({ hello })}\n`);
    socket.once('data', (chunk) => {
      const ask = JSON.parse(String(chunk).trim()) as { hops: number[]; nonce: string };
      asked.push({ hops: ask.hops, at: Date.now() });
      const body = JSON.stringify({ ok: true, accepted: ask.hops, refused: [], recordedAt: 1 });
      socket.end(`${JSON.stringify({ body, proof: proven(['reply', ask.nonce, body]) })}\n`);
    });
  });
  await new Promise<void>((done) => core!.listen(path, done));
  return path;
}

function envFor(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path' || key === 'CLAUDE_CONFIG_DIR') continue;
    env[key] = value;
  }
  const path = process.env.PATH ?? process.env.Path ?? '';
  return {
    ...env,
    ...extra,
    [process.platform === 'win32' ? 'Path' : 'PATH']: `${extra.BIN}${delimiter}${path}`,
  };
}

const readPid = (file: string) =>
  existsSync(file) ? (readFileSync(file, 'utf8').split(' ').map(Number) as [number, number]) : null;

/** Временные дома, подставной `pnpm`, ядро; запуск сторожа на данных портах. */
async function stand() {
  root = mkdtempSync(join(tmpdir(), 'cc-keepalive-hops-'));
  const bin = join(root, 'bin');
  const coreHome = join(root, 'core');
  const userHome = join(root, 'home');
  for (const dir of [bin, coreHome, userHome, join(root, 'local')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'alive'), '');
  const fake = join(root, 'fake-half.mjs');
  writeFileSync(fake, FAKE_HALF);
  writeFileSync(join(bin, 'pnpm.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const asked: Asked[] = [];
  const channel = await provenCore(coreHome, asked);
  writeFileSync(join(coreHome, 'supervisor-token'), TOKEN);
  writeFileSync(
    join(coreHome, 'procs.json'),
    JSON.stringify({ v: 1, cores: [{ supervisor: channel }] }),
  );
  const dir = root;
  const launch = (port: number, webPort: number) => {
    keepalive = spawn(process.execPath, [SCRIPT], {
      env: envFor({
        BIN: bin,
        FAKE_DIR: dir,
        PORT: String(port),
        WEB_PORT: String(webPort),
        AGENTDECK_CORE_HOME: coreHome,
        LOCALAPPDATA: join(dir, 'local'),
        USERPROFILE: userHome,
        HOME: userHome,
      }),
      stdio: 'ignore',
      windowsHide: true,
    });
  };
  return { asked, launch };
}

/** Первая просьба `hops.set`, где названы все `want()`, — или `undefined` к сроку. */
async function askedFor(asked: Asked[], want: () => number[] | null, deadline: number) {
  while (Date.now() < deadline) {
    const pids = want();
    const hit = pids && asked.find((item) => pids.every((pid) => item.hops.includes(pid)));
    if (hit) return hit;
    await new Promise((done) => setTimeout(done, 100));
  }
  return undefined;
}

describe('keepalive records the panel halves to the core as soon as they listen', () => {
  it('a stand already listening (adopted) is recorded at boot, not on the 20 s probe', async () => {
    const { asked, launch } = await stand();
    // Обе «половины» слушает этот процесс: так выглядит панель, поднятая руками до сторожа.
    const halves = [createServer((s) => s.end()), createServer((s) => s.end())];
    for (const half of halves) await new Promise<void>((done) => half.listen(0, '127.0.0.1', done));
    const [port, webPort] = halves.map((half) => (half.address() as AddressInfo).port);
    try {
      const startedAt = Date.now();
      launch(port!, webPort!);
      const hit = await askedFor(asked, () => [process.pid], startedAt + 15_000);
      expect(
        hit,
        `hops.set named the adopted listener; asked: ${JSON.stringify(asked)}`,
      ).toBeDefined();
      expect(hit!.at - startedAt).toBeLessThan(8_000);
    } finally {
      for (const half of halves) await new Promise<void>((done) => half.close(() => done()));
    }
  }, 40_000);

  it('both started halves reach hops.set within seconds of listening, not on the 20 s probe', async () => {
    const { asked, launch } = await stand();
    const [port, webPort] = [await freePort(), await freePort()];
    const startedAt = Date.now();
    launch(port, webPort);
    // Прежний код писал звенья на первом опросе — через 20 с; ждём 15 с от старта сторожа.
    const dir = root;
    const halves = () => [readPid(join(dir, 'server.pid')), readPid(join(dir, 'web.pid'))];
    const hit = await askedFor(
      asked,
      () => {
        const [server, web] = halves();
        return server && web ? [server[0], web[0]] : null;
      },
      startedAt + 15_000,
    );
    const [server, web] = halves();
    expect(server, 'the server half listened').not.toBeNull();
    expect(web, 'the web half listened').not.toBeNull();
    expect(hit, `hops.set named both listeners; asked: ${JSON.stringify(asked)}`).toBeDefined();
    // Запись — вскоре после того, как встал последний слушатель: опрос слушателя, не порта.
    const lastListen = Math.max(server![1], web![1]);
    expect(hit!.at - lastListen).toBeLessThan(8_000);
  }, 40_000);
});
