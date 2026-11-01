import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { contentSha, mutantFiles, pathKey } from './dev-watch.mjs';

/**
 * Dev-сторож и проверка поломкой mustfail: настоящий `dev-watch.mjs` над крошечным «сервером» в
 * git-репозитории во временной папке и настоящий `mustfail.mjs` кита, который переписывает файл этого
 * сервера, пока идёт его проверка.
 *
 * Ради чего (живое наблюдение 25.10, g0 #7). mustfail пишет мутанта прямо в рабочую копию, и его журнал —
 * `<git-dir>/mustfail/journal-<pid>.json`, а не панельный журнал проверок. Сторож видел правку, перезапускал
 * панель на мутанте `conflicts.ts`, и живые группы судились сломанным кодом; когда mustfail возвращал
 * файл, следовал второй, лишний перезапуск. Сторож обязан ждать, пока мутант стоит, и не перезапускать
 * ради файла, вернувшегося к оригиналу.
 *
 * Процессы теста снимаются по записанным номерам, по одному и только живые.
 */

/** `DW_SRC` — сторож под проверкой (прогон на прежнем коде для «красного до»). */
const DEV_WATCH = process.env.DW_SRC
  ? new URL(`file:///${process.env.DW_SRC.replace(/\\/g, '/')}`)
  : new URL('./dev-watch.mjs', import.meta.url);
const PROBE = new URL('./dev-boot-probe.mjs', import.meta.url);
const BRAND = new URL('./brand.mjs', import.meta.url);
const RESTART = new URL('./dev-restart.mjs', import.meta.url);
const HOP_RECORDER = new URL('./hop-recorder.mjs', import.meta.url);
// Сторож пишет звенья ядру (P131): дом ядра теста — пустой временный, не настоящий.
process.env.AGENTDECK_CORE_HOME = mkdtempSync(join(tmpdir(), 'dw-core-'));
const MUSTFAIL = fileURLToPath(
  new URL('../../assets/kit/agentdeck-kit/tools/mustfail.mjs', import.meta.url),
);

/** Проверка mustfail: держит мутанта на диске три секунды и краснеет на нём. */
const CHECK = `import { readFileSync } from 'node:fs';
const text = readFileSync('apps/server/src/lib/part.ts', 'utf8');
await new Promise((resolve) => setTimeout(resolve, 3000));
process.exit(text.includes("'vX'") ? 1 : 0);
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

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

afterEach(async () => {
  if (watch && watch.exitCode === null && watch.signalCode === null) watch.kill();
  watch = undefined;
  for (const pid of recorded) if (alive(pid)) process.kill(pid);
  recorded.clear();
  await pause(300);
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  root = undefined;
});

describe('журнал mustfail глазами сторожа', () => {
  it('держит только мутанта живого прогона под корнями сервера', () => {
    root = mkdtempSync(join(tmpdir(), 'dev-watch-journal-'));
    const src = join(root, 'src');
    const state = join(root, 'state');
    mkdirSync(src, { recursive: true });
    mkdirSync(state, { recursive: true });
    const held = join(src, 'held.ts');
    const back = join(src, 'back.ts');
    const outside = join(root, 'outside.ts');
    for (const file of [held, back, outside]) writeFileSync(file, 'orig');
    const orig = contentSha(back);
    writeFileSync(held, 'mutant');
    writeFileSync(outside, 'mutant');
    const entry = { backup: 'b', before: orig, written: [] };
    const files = { [held]: entry, [back]: entry, [outside]: entry };
    writeFileSync(join(state, 'journal-1.json'), JSON.stringify({ pid: 1, files }));
    writeFileSync(join(state, 'journal-1.json.tmp'), '{');

    const live = mutantFiles(state, [src], () => true);
    expect(live.unreadable).toBe(false);
    expect([...live.files.keys()]).toEqual([pathKey(held)]);
    expect(live.files.get(pathKey(held))).toBe(orig);
    expect([...live.journaled.keys()].sort()).toEqual([pathKey(back), pathKey(held)].sort());

    // Умерший прогон (или чужой процесс с его номером) не держит ничего.
    const dead = mutantFiles(state, [src], () => false);
    expect(dead.files.size + dead.journaled.size).toBe(0);

    // Журнал, который не читается, — «занято».
    writeFileSync(join(state, 'journal-2.json'), '{');
    expect(mutantFiles(state, [src], () => true).unreadable).toBe(true);
    expect(mutantFiles(join(root, 'none'), [src], () => true).unreadable).toBe(false);
  });
});

describe('dev-сторож и mustfail', () => {
  it('мутант на диске держит перезапуск, вернувшийся файл перезапуска не стоит', async () => {
    root = mkdtempSync(join(tmpdir(), 'dev-watch-mustfail-'));
    const serverDir = join(root, 'apps', 'server');
    const lib = join(serverDir, 'src', 'lib');
    mkdirSync(lib, { recursive: true });
    mkdirSync(join(root, 'packages', 'contracts', 'src'), { recursive: true });
    copyFileSync(DEV_WATCH, join(lib, 'dev-watch.mjs'));
    copyFileSync(PROBE, join(lib, 'dev-boot-probe.mjs'));
    copyFileSync(BRAND, join(lib, 'brand.mjs'));
    copyFileSync(RESTART, join(lib, 'dev-restart.mjs'));
    copyFileSync(HOP_RECORDER, join(lib, 'hop-recorder.mjs'));
    writeFileSync(join(lib, 'part.ts'), "export const part: string = 'v1';\n");
    writeFileSync(
      join(serverDir, 'src', 'index.ts'),
      `import { appendFileSync } from 'node:fs';\nimport { part } from './lib/part.ts';\nappendFileSync(process.env.PIDS_FILE as string, \`\${process.pid} \${part}\\n\`);\nsetInterval(() => {}, 1000);\n`,
    );
    writeFileSync(join(root, 'check.mjs'), CHECK);
    writeFileSync(join(root, '.gitignore'), 'config/\npids.txt\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const config = join(root, 'config');
    const { appDataDirOf } = (await import(BRAND.href)) as {
      appDataDirOf: (configRoot: string) => string;
    };
    const appData = appDataDirOf(config);
    mkdirSync(appData, { recursive: true });
    const pidsFile = join(root, 'pids.txt');
    let log = '';
    watch = spawn(process.execPath, [join(lib, 'dev-watch.mjs')], {
      cwd: serverDir,
      env: {
        ...process.env,
        AGENTDECK_DEV_QUIET_MS: '300',
        CLAUDE_CONFIG_DIR: config,
        AGENTDECK_DEV_DEFER_POLL_MS: '200',
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
    await until(() => launches()[0], 30_000, `первый запуск\n${log}`);

    let mustfailOut = '';
    const mustfail = spawn(
      process.execPath,
      [
        MUSTFAIL,
        '--mutate',
        'apps/server/src/lib/part.ts',
        '--find',
        "'v1'",
        '--replace',
        "'vX'",
        '--cmd',
        'node check.mjs',
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    if (mustfail.pid) recorded.add(mustfail.pid);
    mustfail.stdout?.on('data', (chunk: Buffer) => (mustfailOut += chunk.toString()));
    mustfail.stderr?.on('data', (chunk: Buffer) => (mustfailOut += chunk.toString()));
    // Мутант на диске: правку сторож увидел, а перезапуск ждёт, пока его держит живой mustfail.
    const stateFile = join(appData, 'dev-restart.json');
    const state = await until(
      () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : undefined),
      30_000,
      `ожидание при мутанте\n${log}\n${mustfailOut}`,
    );
    expect(state).toMatchObject({ waitingFor: 'checks', files: ['apps/server/src/lib/part.ts'] });
    const code = await new Promise<number | null>((done) => mustfail.on('close', done));
    expect(code, mustfailOut).toBe(0);
    expect(readFileSync(join(lib, 'part.ts'), 'utf8')).toContain("'v1'");

    // Файл вернулся к оригиналу — сервер и так на нём: ни второго запуска, ни ожидания.
    // Контроль mustfail (тот же текст той же записью) идёт до мутанта и уже дал такую строку;
    // снятие ожидания — строка ПОСЛЕ отсрочки. Под нагрузкой она приходит позже 1,5 с после
    // выхода mustfail (замер 28.10: 1,75–1,9 с в двух из шести параллельных прогонов), и
    // проверка, поймавшая строку контроля, краснела на ещё не снятом состоянии.
    await until(
      () =>
        /перезапуск отложен[\s\S]*вернулись к оригиналу — перезапуск не нужен/.test(log) &&
        !existsSync(stateFile)
          ? true
          : undefined,
      30_000,
      `снятие ожидания\n${log}`,
    );
    await pause(1_500);
    expect(launches()).toEqual([expect.stringMatching(/ v1$/)]);
    expect(existsSync(stateFile)).toBe(false);

    // Настоящая правка после mustfail перезапускает, как прежде.
    writeFileSync(join(lib, 'part.ts'), "export const part: string = 'v2';\n");
    const second = await until(() => launches()[1], 60_000, `перезапуск на правке\n${log}`);
    expect(second.split(' ')[1]).toBe('v2');
  }, 120_000);
});
