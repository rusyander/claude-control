import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Dev-сторож как процесс: настоящий `dev-watch.mjs` над крошечным «сервером» во
 * временной папке — падение, сломанная правка, исправление, уход родителя.
 *
 * Ради чего. Сторож гасит и поднимает сервер, и ошибка в этом месте стоит
 * дорого в обе стороны: сломанная правка, погасившая работающий сервер, —
 * пустая панель; снятие ДЕРЕВОМ по номеру процесса (`taskkill /T`) цепляет
 * чужие процессы, чей давно умерший родитель носил тот же номер (так 27.09
 * погиб сторож стенда владельца). Поэтому «сервер» здесь сам запускает
 * внука: сторож обязан снять ровно сервер, а внук — пережить это. Внук
 * `detached`, как посредник чата: неотвязанного на Windows снимает сам libuv
 * (задание процесса гибнет с родителем), и его смерть ничего бы не доказала,
 * а отвязанный переживает родителя — его снимет только дерево.
 *
 * Все процессы теста снимаются по записанным номерам, по одному и только
 * живые — ни деревом, ни по имени, ни по порту.
 */

const DEV_WATCH = new URL('./dev-watch.mjs', import.meta.url);
const PROBE = new URL('./dev-boot-probe.mjs', import.meta.url);
const BRAND = new URL('./brand.mjs', import.meta.url);

const FAKE_SERVER = `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { part } from './lib/part.ts';
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  detached: true,
});
grand.unref();
appendFileSync(process.env.PIDS_FILE as string, \`\${process.pid} \${grand.pid} \${part}\\n\`);
setInterval(() => {}, 1000);
`;

let root: string | undefined;
let watch: ChildProcess | undefined;
const recorded = new Set<number>();

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until<T>(read: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`не дождался: ${what}`);
    await pause(100);
  }
}

afterEach(async () => {
  // Сторож — свой ребёнок: объект процесса знает, жив ли он, номер не чужой.
  if (watch && watch.exitCode === null && watch.signalCode === null) watch.kill();
  watch = undefined;
  // Сервер и внуки — по номерам, которые они сами записали; только живые, по одному.
  for (const pid of recorded) if (alive(pid)) process.kill(pid);
  recorded.clear();
  await pause(300);
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  root = undefined;
});

describe('dev-сторож как процесс', () => {
  it('падение поднимает, сломанная правка не гасит, уход родителя снимает ровно сервер', async () => {
    root = mkdtempSync(join(tmpdir(), 'dev-watch-proc-'));
    const serverDir = join(root, 'apps', 'server');
    const lib = join(serverDir, 'src', 'lib');
    mkdirSync(lib, { recursive: true });
    mkdirSync(join(root, 'packages', 'contracts', 'src'), { recursive: true });
    copyFileSync(DEV_WATCH, join(lib, 'dev-watch.mjs'));
    copyFileSync(PROBE, join(lib, 'dev-boot-probe.mjs'));
    copyFileSync(BRAND, join(lib, 'brand.mjs'));
    writeFileSync(join(lib, 'part.ts'), "export const part: string = 'v1';\n");
    writeFileSync(join(serverDir, 'src', 'index.ts'), FAKE_SERVER);
    const pidsFile = join(root, 'pids.txt');

    let log = '';
    watch = spawn(process.execPath, [join(lib, 'dev-watch.mjs')], {
      cwd: serverDir,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        AGENTDECK_DEV_DEFER: '0',
        PIDS_FILE: pidsFile,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    watch.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    watch.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));

    const launches = (): string[][] => {
      if (!existsSync(pidsFile)) return [];
      const rows = readFileSync(pidsFile, 'utf8').split(/\r?\n/).filter(Boolean);
      const parsed = rows.map((row) => row.split(' '));
      for (const [server, grand] of parsed) {
        recorded.add(Number(server));
        recorded.add(Number(grand));
      }
      return parsed;
    };
    const launch = (n: number) =>
      until(() => launches()[n - 1], 30_000, `запуск сервера №${n}\n${log}`);

    const [first] = await launch(1);
    const firstPid = Number(first);

    // 1. Сервер упал сам — сторож поднимает его снова, не дожидаясь правки.
    process.kill(firstPid);
    const [second, secondGrand] = await launch(2);
    const secondPid = Number(second);
    expect(secondPid).not.toBe(firstPid);
    expect(log).toMatch(/сервер вышел .*поднимаю снова через 1 с/);

    // 2. Сломанная правка модуля из графа — прежний сервер работает дальше.
    writeFileSync(join(lib, 'part.ts'), 'export const part = ;\n');
    await until(
      () => (/новая сборка не поднимается — работает прежняя/.test(log) ? true : undefined),
      30_000,
      `отказ пробы\n${log}`,
    );
    expect(log).toMatch(/part\.ts/);
    expect(alive(secondPid)).toBe(true);
    expect(launches()).toHaveLength(2);

    // 3. Исправление — обычный перезапуск: прежний сервер снят, новый с новым кодом.
    writeFileSync(join(lib, 'part.ts'), "export const part: string = 'v2';\n");
    const third = await launch(3);
    const thirdPid = Number(third[0]);
    const thirdGrand = Number(third[1]);
    expect(third[2]).toBe('v2');
    await until(() => (alive(secondPid) ? undefined : true), 10_000, 'снятие прежнего сервера');
    // Прежний сервер снят без дерева: его внук жив.
    expect(alive(Number(secondGrand))).toBe(true);

    // 4. Родитель ушёл (канал IPC закрыт) — сторож гасит свой сервер и выходит сам.
    const exited = new Promise<number | null>((resolve) => watch?.once('exit', resolve));
    watch.disconnect();
    await Promise.race([exited, pause(10_000)]);
    expect(watch.exitCode).toBe(0);
    await until(() => (alive(thirdPid) ? undefined : true), 10_000, 'снятие сервера сторожем');
    expect(alive(thirdGrand)).toBe(true);
  }, 120_000);

  // Ревью 28.09 (F-199): проба после падения провалилась не из-за правки
  // (здесь — файл вне наблюдаемых каталогов пропал и вернулся) — сторож ждал
  // правку вечно, и сервер так и лежал.
  it('провал пробы без правки повторяется — сервер поднимается сам', async () => {
    root = mkdtempSync(join(tmpdir(), 'dev-watch-reprobe-'));
    const serverDir = join(root, 'apps', 'server');
    const lib = join(serverDir, 'src', 'lib');
    const gate = join(serverDir, 'src', '.gate');
    mkdirSync(lib, { recursive: true });
    mkdirSync(gate, { recursive: true });
    mkdirSync(join(root, 'packages', 'contracts', 'src'), { recursive: true });
    copyFileSync(DEV_WATCH, join(lib, 'dev-watch.mjs'));
    copyFileSync(PROBE, join(lib, 'dev-boot-probe.mjs'));
    copyFileSync(BRAND, join(lib, 'brand.mjs'));
    // Каталог с точкой сторож не наблюдает: его файл пропадает и возвращается без правки.
    const gateFile = join(gate, 'gate.mjs');
    writeFileSync(gateFile, 'export const gate = 1;\n');
    writeFileSync(
      join(serverDir, 'src', 'index.ts'),
      `import { appendFileSync } from 'node:fs';\nimport { gate } from './.gate/gate.mjs';\nappendFileSync(process.env.PIDS_FILE as string, \`\${process.pid} \${gate}\\n\`);\nsetInterval(() => {}, 1000);\n`,
    );
    const pidsFile = join(root, 'pids.txt');
    let log = '';
    watch = spawn(process.execPath, [join(lib, 'dev-watch.mjs')], {
      cwd: serverDir,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        AGENTDECK_DEV_DEFER: '0',
        PIDS_FILE: pidsFile,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    watch.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    watch.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    const launches = (): string[] => {
      if (!existsSync(pidsFile)) return [];
      const rows = readFileSync(pidsFile, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const row of rows) recorded.add(Number(row.split(' ')[0]));
      return rows;
    };

    const [first] = await until(() => launches()[0], 30_000, `первый запуск\n${log}`).then((row) =>
      row.split(' '),
    );
    rmSync(gateFile);
    process.kill(Number(first));
    await until(
      () => (/новая сборка не поднимается/.test(log) ? true : undefined),
      30_000,
      `провал пробы\n${log}`,
    );
    writeFileSync(gateFile, 'export const gate = 2;\n');
    const second = await until(() => launches()[1], 60_000, `подъём без правки\n${log}`);
    expect(second.split(' ')[1]).toBe('2');
  }, 120_000);
});
