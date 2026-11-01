import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * P131 (08b:52, F5): после перезапуска панели надзор записывает новый pid в набор доверенных
 * звеньев до первой команды через неё; прежний pid выпадает, его пересланная команда — пир без
 * доверия (строгая — только с подписью устройства).
 *
 * Ничего не подложено руками: ядро — настоящая загрузка (`bootCore`, канал надзора, набор
 * звеньев, чтение пира ОС); панель — настоящая прокладка `proxy-host.ts` отдельным процессом;
 * записывает звенья настоящий `hop-recorder.mjs` — командой (как `keepalive`) и изнутри
 * настоящего `dev-watch.mjs`, который сам запускает сервер панели.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '../../../server');
const LIB = join(SERVER, 'src/lib');
const PROXY_HOST = join(SERVER, 'src/routes/core-proxy/__fixtures__/proxy-host.ts');
const RECORDER = join(LIB, 'hop-recorder.mjs');
/** `DW_SRC` — сторож под проверкой (мутант для «красного до»); иначе настоящий. */
const DEV_WATCH = process.env.DW_SRC ?? join(LIB, 'dev-watch.mjs');

const children: ChildProcess[] = [];
let core: BootedCore | undefined;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once('exit', done));
      child.kill();
      await exited;
    }
  }
  await core?.stop();
  core = undefined;
});

/** Первая строка JSON с портом из потока процесса. */
type ProxyLine = { port: number; pid: number; hopRecord: boolean };

function portLine(child: ChildProcess, what: string): Promise<ProxyLine> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${what} did not start`)), 60_000);
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => {
      if (!line.startsWith('{"port"')) return;
      clearTimeout(timer);
      lines.close();
      done(JSON.parse(line) as ProxyLine);
    });
  });
}

function startProxy(home: string) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', PROXY_HOST],
    {
      cwd: SERVER,
      env: { ...process.env, AGENTDECK_CORE_HOME: home, AGENTDECK_HOP_RECORD: undefined },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  children.push(child);
  return portLine(child, 'proxy');
}

/** Настоящий `dev-watch.mjs` в одноразовом корне: его «сервер» — та же прокладка панели. */
function startDevWatch(home: string) {
  const root = tempDir('p131-dw-');
  const serverDir = join(root, 'apps', 'server');
  const lib = join(serverDir, 'src', 'lib');
  mkdirSync(lib, { recursive: true });
  copyFileSync(DEV_WATCH, join(lib, 'dev-watch.mjs'));
  for (const name of ['dev-boot-probe.mjs', 'brand.mjs', 'dev-restart.mjs', 'hop-recorder.mjs'])
    copyFileSync(join(LIB, name), join(lib, name));
  writeFileSync(
    join(serverDir, 'src', 'index.ts'),
    `await import(${JSON.stringify(pathToFileURL(PROXY_HOST).href)});\n`,
  );
  const child = spawn(process.execPath, [join(lib, 'dev-watch.mjs')], {
    cwd: serverDir,
    env: {
      ...process.env,
      AGENTDECK_CORE_HOME: home,
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      AGENTDECK_DEV_DEFER: '0',
      // Порт фронта без слушателя: звено здесь одно — сервер, запущенный сторожем.
      WEB_PORT: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    windowsHide: true,
  });
  children.push(child);
  return portLine(child, 'dev-watch server');
}

function record(home: string, pids: number[]): Promise<unknown[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [RECORDER, ...pids.map(String)], {
      env: { ...process.env, AGENTDECK_CORE_HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('error', fail);
    child.once('exit', () => done(JSON.parse(out) as unknown[]));
  });
}

describe('P131 the supervisor records the panel hop before its first command; the old hop is dropped', () => {
  it('no record → signature-required; recorder → allowed; dev-watch relaunch → new pid allowed at once, old pid → signature-required', async () => {
    const home = join(tempDir('p131-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = await createTaskRegistry(layout.tasks, deps()).create(CREATED);
    const taskId = seed.taskId;
    seed.close();
    core = await bootCore({ home, build: 'p131' });
    const coreToken = readFileSync(layout.token, 'utf8').trim();
    const procs = JSON.parse(readFileSync(layout.procs, 'utf8')) as {
      cores: { bootId: string; supervisor?: string }[];
    };
    expect(procs.cores.find((row) => row.bootId === core?.bootId)?.supervisor).toBeTruthy();

    const nonce = async () => {
      const page = newId();
      const res = await fetch(`${core?.url}/v1/nonce?page=${page}`, {
        headers: { authorization: `Bearer ${coreToken}` },
      });
      return { page, nonce: ((await res.json()) as { nonce: string }).nonce };
    };
    // Пауза черновика: прошедшая суд полномочий — конфликт состояния; не прошедшая — отказ суда.
    const command = async (port: number) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/core/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cmdId: newId(),
          kind: 'pause',
          target: { taskId },
          fields: { now: false },
          proof: await nonce(),
        }),
      });
      return ((await res.json()) as { code?: string }).code;
    };
    const health = async () => {
      const res = await fetch(`${core?.url}/v1/health`, {
        headers: { authorization: `Bearer ${coreToken}` },
      });
      return ((await res.json()) as { trustedHops: { count: number } }).trustedHops;
    };

    // Панель, которую никто не записал: её пересланный pid ядро не принимает.
    const a = await startProxy(home);
    // Сторожа нет — и файла итога нет: ворота записи эту панель не держат.
    expect(a.hopRecord).toBe(false);
    expect(await command(a.port)).toBe('signature-required');
    expect(await health()).toMatchObject({ count: 0 });

    // Запись настоящим рекордером (как `keepalive`): та же панель проходит суд пира.
    expect(await record(home, [a.pid])).toEqual([
      expect.objectContaining({ ok: true, accepted: [a.pid], refused: [] }),
    ]);
    expect(await command(a.port)).toBe('state-conflict');

    // Перезапуск панели — новый сервер от dev-watch. Команда сразу, как он слушает.
    const b = await startDevWatch(home);
    expect(b.pid).not.toBe(a.pid);
    // dev-watch отдал серверу файл итога: первая команда ждёт записи, а не обгоняет её.
    expect(b.hopRecord).toBe(true);
    expect(await command(b.port)).toBe('state-conflict');
    // Прежний pid жив и пересылает — но больше не звено.
    expect(await command(a.port)).toBe('signature-required');
    expect(await health()).toMatchObject({ count: 1 });

    const notes = readFileSync(join(layout.logs, 'core.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"hops.set"'));
    expect(notes).toHaveLength(2);
  }, 180_000);
});
