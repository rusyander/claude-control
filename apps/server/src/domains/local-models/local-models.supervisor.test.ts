import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths } from './paths.ts';
import { IDLE_SLEEP_SECONDS, readRecord, type ServerShape } from './server.ts';
import { HUNG_AFTER_MISSES, MAX_RESTARTS } from './supervisor.ts';
import { modelFilePath } from './hf.ts';
import type { FetchLike } from './download.ts';

/**
 * Присмотр за сервером на настоящем сервисе (L4b): запись о сервере, подъём по ней и
 * сообщение карточки — настоящие; подменены сеть до llama-server, запуск процесса и
 * «жив ли номер процесса». Шлюз приходит сюда через `upstream(model).revive()`.
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_498;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

let root: string;
let up: boolean;
let nextPid: number;
let alive: Set<number>;
let spawned: number;
/** Запуск не удаётся: процесс сразу выходит с кодом. */
let crashOnStart: boolean;
/** Через сколько снятый процесс «уходит»; 0 — сразу. */
let killDelayMs = 0;

const net: FetchLike = async (input) => {
  if (!String(input).startsWith(`http://127.0.0.1:${PORT}`)) throw new TypeError('fetch failed');
  if (!up) throw new TypeError('fetch failed');
  if (String(input).endsWith('/health')) return Response.json({ status: 'ok' });
  return new Response('{}', { status: 404 });
};

const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  PATH: '',
  LOCALAPPDATA: join(root, 'appdata'),
  ProgramFiles: join(root, 'programs'),
  HOME: root,
  USERPROFILE: root,
});

function service() {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    fetchImpl: net,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, _args: string[]) => {
      spawned += 1;
      const pid = nextPid++;
      if (crashOnStart) {
        return {
          pid,
          once: (event: string, callback: (code: number) => void) => {
            if (event === 'exit') callback(1);
          },
          unref: () => undefined,
        };
      }
      up = true;
      alive.add(pid);
      return { pid, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      up = false;
      // Снятый процесс отпускает порт не сразу: окно, в котором человек успевает нажать «Стоп».
      if (killDelayMs > 0) setTimeout(() => alive.delete(pid), killDelayMs).unref();
      else alive.delete(pid);
    },
    supervise: { pidAlive: (pid) => alive.has(pid) },
  });
}

function seededShape(paths: ReturnType<typeof localPaths>): ServerShape {
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  if (!model) throw new Error('27B not in catalog');
  const quant = model.quants.find((item) => item.id === model.defaultQuant);
  if (!quant) throw new Error('default quant missing');
  return {
    tag: TAG,
    file: modelFilePath(paths, model.repo, quant.file),
    quant: quant.id,
    context: 65_536,
    kvCache: 'q8_0',
    device: 'gpu',
    mtp: true,
    offload: 'all',
    idleSeconds: IDLE_SLEEP_SECONDS,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-supervisor-'));
  spawned = 0;
  nextPid = 7_000;
  alive = new Set();
  crashOnStart = false;
  killDelayMs = 0;
  up = false;
  const paths = localPaths(root, ENV());
  const runtimeDir = join(paths.runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
  const shape = seededShape(paths);
  stubs.writeGguf(shape.file, { nextn: 1 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function startedAndKilled(local: ReturnType<typeof service>): Promise<number> {
  await local.startServer({ tag: TAG });
  const record = readRecord(localPaths(root, ENV()));
  if (!record) throw new Error('no record after start');
  // Сервер падает: порт закрыт, процесса нет, запись о нём остаётся.
  up = false;
  alive.delete(record.pid);
  return record.pid;
}

describe('сервер моделей упал — присмотр поднимает его по записи', () => {
  it('шлюз просит подъём: сервер стартует заново теми же параметрами, окно не меняется', async () => {
    const local = service();
    const before = await startedAndKilled(local);
    const info = local.upstream(TAG);
    expect(info).toBeDefined();
    const outcome = await info?.revive();
    expect(outcome).toBe('restarted');
    expect(spawned).toBe(2);
    const record = readRecord(localPaths(root, ENV()));
    expect(record?.pid).not.toBe(before);
    expect(record?.context).toBe(65_536);
    expect(record?.tag).toBe(TAG);
    expect(up).toBe(true);
    // Сообщение видно карточке сервера.
    expect((await local.describe()).server.notice).toMatchObject({ kind: 'restarted' });
  });

  it('сервер остановлен человеком — записи нет, воскрешения нет', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    await local.stopServer();
    expect(await local.upstream(TAG)?.revive()).toBeUndefined();
    expect(spawned).toBe(1);
  });

  it('жив и отвечает — шлюз получает «alive», второго процесса нет', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    expect(await local.upstream(TAG)?.revive()).toBe('alive');
    expect(spawned).toBe(1);
  });

  it('подъём не удаётся: после трёх попыток — потолок, причина в сообщении карточки и в тексте для шлюза', async () => {
    const local = service();
    await startedAndKilled(local);
    crashOnStart = true;
    const info = local.upstream(TAG);
    for (let i = 0; i < MAX_RESTARTS; i += 1) expect(await info?.revive()).toBe('failed');
    expect(await info?.revive()).toBe('capped');
    // Попыток запуска ровно потолок: четвёртая не делается.
    expect(spawned).toBe(1 + MAX_RESTARTS);
    expect(info?.notice()).toContain('не поднялся после');
    const shown = (await local.describe()).server.notice;
    expect(shown).toMatchObject({ kind: 'gave-up', restarts: MAX_RESTARTS });
    expect(shown?.reason).toBeTruthy();
  });

  it('человек запускает сервер сам — потолок сброшен, сообщение снято', async () => {
    const local = service();
    await startedAndKilled(local);
    crashOnStart = true;
    const info = local.upstream(TAG);
    for (let i = 0; i < MAX_RESTARTS + 1; i += 1) await info?.revive();
    crashOnStart = false;
    await local.startServer({ tag: TAG });
    expect((await local.describe()).server.notice).toBeUndefined();
    expect(info?.notice()).toBeUndefined();
  });
});

describe('«Стоп» человека посреди подъёма зависшего сервера (L4c, F4)', () => {
  it('процесс жив, /health молчит; присмотр снимает его и ждёт порт; Стоп в этом окне — сервер не поднимается', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const info = local.upstream(TAG);
    // Зависший: порт молчит, процесс жив. Снятие отпускает его не сразу — окно ожидания порта.
    up = false;
    for (let i = 0; i < HUNG_AFTER_MISSES - 1; i += 1) expect(await info?.revive()).toBe('alive');
    killDelayMs = 700;
    const spawnedBefore = spawned;
    const recovery = info?.revive();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await local.stopServer();
    const outcome = await recovery;
    expect(outcome).toBe('none');
    expect(spawned).toBe(spawnedBefore);
    expect(readRecord(localPaths(root, ENV()))).toBeUndefined();
    expect((await local.describe()).server.notice).toBeUndefined();
  });
});
