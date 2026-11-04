import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { killLeftovers, readProcessTable } from './kill-tree.mjs';
import { removeEntry } from './safe-io/safe-io.ts';

/**
 * Панель съёмки справки — со своим домом и своим ядром под надзором (этап 10, зона C, проход 7).
 * Настоящие процессы: съёмщик (как `tools/help-shots/*-panel.mjs`: окружение оболочки +
 * `CLAUDE_CONFIG_DIR` + `PORT`) поднимает сервер панели, надзор панели поднимает ядро.
 *
 * Дом человека в проверке — временный каталог: съёмщик запущен с `HOME`/`USERPROFILE` на нём, так
 * что «дом человека» для него — этот каталог; настоящий `~/.agentdeck` не трогается.
 * До прохода 7 ядро панели съёмки садилось на `<дом>/.agentdeck/core` и слушало шлюз 5179.
 * `PANEL_CORE_SRC` — модуль под проверкой (прежнее поведение для «красного до»).
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const HELPER = pathToFileURL(
  process.env.PANEL_CORE_SRC
    ? resolve(process.env.PANEL_CORE_SRC)
    : join(REPO, 'tools', 'help-shots', 'panel-core.mjs'),
).href;
const STAND = pathToFileURL(join(REPO, 'tools', 'qa', 'throwaway-stand.mjs')).href;
const IS_WIN = process.platform === 'win32';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const scratch = mkdtempSync(join(tmpdir(), 'help-core-'));
const mine = new Map<number, bigint>();
const children: ChildProcess[] = [];
/** Каталоги ядра, которые завёл съёмщик: упавшая проверка до `reap()` не доходит. */
const roots: string[] = [];

/**
 * Съёмщик: собирает окружение панели так, как это делают съёмщики справки, пропускает его через
 * `isolatePanelCore`, поднимает сервер и ждёт `stop` на stdin — тогда снимает панель и зовёт
 * `reap()`, как `finally` съёмщика. Пишет строкой JSON, что поднял.
 */
const DRIVER = join(scratch, 'shooter.mjs');
writeFileSync(
  DRIVER,
  [
    "import { spawn, spawnSync } from 'node:child_process';",
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `const { isolatePanelCore } = await import(${JSON.stringify(HELPER)});`,
    `const { freePort } = await import(${JSON.stringify(STAND)});`,
    'const cfg = process.argv[2];',
    "mkdirSync(join(cfg, 'agentdeck'), { recursive: true });",
    "writeFileSync(join(cfg, 'settings.json'), '{}\\n');",
    'const port = await freePort();',
    'const panel = await isolatePanelCore({ ...process.env, CLAUDE_CONFIG_DIR: cfg, PORT: String(port) }, { label: "help-core-test" });',
    "const server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'], { cwd: process.argv[3], env: panel.env, stdio: 'ignore' });",
    'console.log(JSON.stringify({ port, server: server.pid, coreHome: panel.coreHome ?? null, root: panel.root ?? null, gatewayPort: panel.gatewayPort ?? null }));',
    "process.stdin.on('data', (chunk) => {",
    "  if (!String(chunk).includes('stop')) return;",
    "  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });",
    '  else server.kill();',
    '  const out = panel.reap();',
    '  console.log(JSON.stringify({ reaped: true, left: (out && out.left) || [] }));',
    '  process.exit(0);',
    '});',
    '',
  ].join('\n'),
);

interface Started {
  port: number;
  server: number;
  coreHome: string | null;
  root: string | null;
  gatewayPort: number | null;
}

function startShooter(owner: string) {
  const cfg = join(scratch, `cfg-${children.length}`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', DRIVER, cfg, REPO],
    {
      cwd: REPO,
      // Окружение оболочки, а не vitest: под `VITEST`/`NODE_ENV=test` панель ведёт себя как в тестах.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^(VITEST|NODE_ENV$|TEST$)/i.test(key)),
        ),
        HOME: owner,
        USERPROFILE: owner,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  children.push(child);
  const lines: unknown[] = [];
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line.startsWith('{')) lines.push(JSON.parse(line));
    }
  });
  return { child, lines };
}

async function until<T>(read: () => T | undefined, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error('timed out');
    await pause(200);
  }
}

/** Живое ядро из `procs.json` дома: номер и время создания (личность для проверки «снято»). */
function liveCore(home: string): { pid: number; created: bigint } | undefined {
  try {
    const procs = JSON.parse(readFileSync(join(home, 'procs.json'), 'utf8')) as {
      cores?: { pid?: number }[];
    };
    const table = readProcessTable() ?? [];
    for (const row of procs.cores ?? []) {
      const hit = table.find((r) => r.pid === row.pid);
      if (hit) return { pid: hit.pid, created: hit.created };
    }
  } catch {
    // procs.json ещё не записан.
  }
  return undefined;
}

const alive = (id: { pid: number; created: bigint }) =>
  readProcessTable()?.find((r) => r.pid === id.pid)?.created === id.created;

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on('error', () => done(false));
  });
}

afterAll(async () => {
  for (const child of children) child.kill();
  // Свои процессы проверки, которые прежнее поведение оставило (ядро в «доме человека»).
  const { reapStandTree } = (await import(STAND)) as {
    reapStandTree(root: string, o?: object): { left: unknown[] };
  };
  for (const dir of [scratch, ...roots]) reapStandTree(dir, { settleMs: 2_000 });
  for (const dir of roots) removeEntry(dir);
  killLeftovers(mine, { slackMs: 0 });
  await pause(500);
  removeEntry(scratch);
});

describe.runIf(IS_WIN)('help-shot panel runs its own supervised core (real panel + core)', () => {
  it("never the owner's ~/.agentdeck/core, gateway on its own port, teardown reaps the core", async () => {
    const owner = join(scratch, 'owner-home');
    mkdirSync(owner, { recursive: true });
    const ownerCore = join(owner, '.agentdeck', 'core');
    const { child, lines } = startShooter(owner);
    const started = (await until(() => lines[0])) as Started;
    if (started.root) roots.push(started.root);
    // Ядро поднимает надзор панели — ждём его запись в том доме, куда оно село.
    const homes = [ownerCore, ...(started.coreHome ? [started.coreHome] : [])];
    const core = await until(() => {
      for (const home of homes) {
        const id = liveCore(home);
        if (id) return { ...id, home };
      }
      return undefined;
    });
    mine.set(core.pid, core.created);

    expect(existsSync(ownerCore)).toBe(false);
    expect(core.home).toBe(started.coreHome);
    expect(started.gatewayPort).not.toBe(5179);
    // Настоящий шлюз ядра под надзором — на своём порту.
    let up = false;
    for (let round = 0; !up && round < 150; round += 1) {
      up = await listening(started.gatewayPort!);
      if (!up) await pause(200);
    }
    expect(up).toBe(true);

    child.stdin!.write('stop\n');
    const done = (await until(() => lines.find((l) => (l as { reaped?: boolean }).reaped))) as {
      left: unknown[];
    };
    expect(done.left).toEqual([]);
    expect(alive(core)).toBe(false);
    expect(existsSync(started.root!)).toBe(false);
  }, 240_000);
});
