import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalHoldView } from '@agentdeck/contracts/core/local-hold';
import type { CoreHold } from './core-hold.ts';
import { localPaths, type LocalPaths } from './paths.ts';
import {
  holdServer,
  IDLE_SLEEP_SECONDS,
  readRecord,
  releaseServer,
  retireLegacyServer,
  type ServerShape,
} from './server.ts';

/**
 * Переход на ядро на машине, где ещё идёт llama-server прежней панели (её запись `run/llama.json`,
 * постоянный порт и память карты — у него). Прежний сервер здесь — НАСТОЯЩИЙ процесс со своим
 * портом, снимает его настоящее `killProcessTree`; подменено только ядро (вид удержания).
 */

const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
let root: string;
let paths: LocalPaths;
const children: ChildProcess[] = [];
const servers: Server[] = [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return check();
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/** Сервер, отвечающий на пробу здоровья, как llama-server. */
function healthServer(port: number): Promise<Server> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ok"}');
  });
  servers.push(server);
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

/** Прежний llama-server панели: отдельный процесс на постоянном порту + его запись. */
async function legacyServer(port: number, shape: ServerShape): Promise<ChildProcess> {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('http').createServer((q,s)=>s.end('{"status":"ok"}')).listen(${port},'127.0.0.1',()=>console.log('UP'))`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  children.push(child);
  await new Promise<void>((done) => child.stdout?.once('data', () => done()));
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(
    paths.pidFile,
    JSON.stringify({ ...shape, pid: child.pid, port, binary: BINARY, startedAt }),
  );
  return child;
}

function shapeOf(): ServerShape {
  return {
    tag: 'qwen3.5:4b',
    file: join(root, 'model.gguf'),
    quant: 'Q4_K_M',
    context: 8192,
    kvCache: 'q8_0',
    device: 'gpu',
    mtp: false,
    offload: 'all',
    idleSeconds: IDLE_SLEEP_SECONDS,
  };
}

/** Вид ядра: что держит, и где слушает его постоянный адрес. */
function core(options: {
  heldPid?: number;
  front: LocalHoldView['front'];
  onHold?: () => Promise<number>;
}): CoreHold & { holds: number; releases: number } {
  let held = options.heldPid;
  const view = (): LocalHoldView => ({
    held: held
      ? { model: 'qwen3.5:4b', origin: null, pid: held, since: new Date().toISOString() }
      : null,
    live: held !== undefined,
    front: options.front,
  });
  const api = {
    holds: 0,
    releases: 0,
    async hold() {
      api.holds += 1;
      held = (await options.onHold?.()) ?? 7777;
      return view();
    },
    async release() {
      api.releases += 1;
      const had = held !== undefined;
      held = undefined;
      return { released: had, verified: [], leaks: [] };
    },
    async view() {
      return view();
    },
  };
  return api;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-legacy-'));
  paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
});

afterEach(async () => {
  for (const child of children.splice(0)) if (child.pid && alive(child.pid)) child.kill();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  rmSync(root, { recursive: true, force: true });
});

describe('переход на ядро: прежний llama-server панели', () => {
  it('«Запустить» снимает прежний сервер ДО удержания — порт и карта свободны, ядро держит своё', async () => {
    const port = await freePort();
    const legacy = await legacyServer(port, shapeOf());
    const pid = legacy.pid ?? 0;
    let legacyAliveAtHold = true;
    const hold = core({
      front: { port, url: `http://127.0.0.1:${port}`, listening: true },
      onHold: async () => {
        // Ядро грузит модель только после того, как прежний сервер ушёл.
        legacyAliveAtHold = !(await until(() => !alive(pid), 5_000));
        await healthServer(port);
        return 7777;
      },
    });
    const { record } = await holdServer({
      paths,
      binary: BINARY,
      port,
      shape: shapeOf(),
      sizeBytes: 1,
      needBytes: 0,
      hold,
      timeoutMs: 5_000,
    });
    expect(legacyAliveAtHold).toBe(false);
    expect(alive(pid)).toBe(false);
    expect(hold.holds).toBe(1);
    expect(record.pid).toBe(7777);
    expect(readRecord(paths)?.pid).toBe(7777);
  }, 30_000);

  it('«Остановить» снимает прежний сервер, которого ядро не держит, и стирает его запись', async () => {
    const port = await freePort();
    const legacy = await legacyServer(port, shapeOf());
    const hold = core({ front: { port, url: '', listening: false } });
    const stopped = await releaseServer(paths, port, hold);
    expect(stopped.unloaded).toEqual(['qwen3.5:4b']);
    expect(await until(() => !alive(legacy.pid ?? 0), 5_000)).toBe(true);
    expect(existsSync(paths.pidFile)).toBe(false);
  }, 30_000);

  it('сервер, который держит само ядро, прежним не считается и не снимается', async () => {
    const port = await freePort();
    const own = await legacyServer(port, shapeOf());
    const killed: number[] = [];
    const hold = core({ heldPid: own.pid, front: { port, url: '', listening: true } });
    expect(await retireLegacyServer(paths, hold, (p) => void killed.push(p))).toBe(false);
    expect(killed).toEqual([]);
    expect(alive(own.pid ?? 0)).toBe(true);
    expect(readRecord(paths)?.pid).toBe(own.pid);
  }, 30_000);

  it('ядро недоступно — судить нечем, ничего не снимается', async () => {
    const port = await freePort();
    const legacy = await legacyServer(port, shapeOf());
    const killed: number[] = [];
    const down: CoreHold = {
      hold: () => Promise.reject(new Error('down')),
      release: () => Promise.reject(new Error('down')),
      view: async () => undefined,
    };
    expect(await retireLegacyServer(paths, down, (p) => void killed.push(p))).toBe(false);
    expect(killed).toEqual([]);
    expect(alive(legacy.pid ?? 0)).toBe(true);
  }, 30_000);

  it('порт отвечает, но адрес ядра на нём не слушает — «запущено» не говорится, удержание снято', async () => {
    const port = await freePort();
    // Чужой сервер (без записи панели) держит порт; ядро слушает свой адрес на другом порту.
    await healthServer(port);
    const hold = core({ front: { port: port + 1, url: '', listening: true } });
    await expect(
      holdServer({
        paths,
        binary: BINARY,
        port,
        shape: shapeOf(),
        sizeBytes: 1,
        needBytes: 0,
        hold,
        timeoutMs: 800,
      }),
    ).rejects.toMatchObject({ messageCode: 'local-timeout' });
    expect(hold.releases).toBe(1);
    expect(readRecord(paths)).toBeUndefined();
  }, 30_000);
});
