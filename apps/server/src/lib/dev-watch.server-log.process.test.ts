import { afterEach, describe, expect, it } from 'vitest';
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
 * Поток ошибок сервера под сторожем — ещё и в `server.log` каталога данных
 * (журнал 26.10, #g8:30): под keepalive stdout сторожа выброшен, и
 * предупреждения панели не оседали нигде. Настоящий `dev-watch.mjs` над
 * крошечным «сервером», который пишет в stderr; сторож обязан и передать поток
 * дальше (тот, кто смотрит терминал, его видит), и сложить его в журнал.
 *
 * Процессы теста снимаются по записанным номерам, по одному и только живые.
 */

const DEV_WATCH = new URL('./dev-watch.mjs', import.meta.url);
const PROBE = new URL('./dev-boot-probe.mjs', import.meta.url);
const BRAND = new URL('./brand.mjs', import.meta.url);
const RESTART = new URL('./dev-restart.mjs', import.meta.url);
const HOP_RECORDER = new URL('./hop-recorder.mjs', import.meta.url);
// Сторож пишет звенья ядру (P131): дом ядра теста — пустой временный, не настоящий.
process.env.AGENTDECK_CORE_HOME = mkdtempSync(join(tmpdir(), 'dw-core-'));

const FAKE_SERVER = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PIDS_FILE as string, \`\${process.pid}\\n\`);
console.error('permission-request: Bash toolu_slow answered in 131 s');
process.stderr.write('\\n\\nвторая строка предупреждения\\n');
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
  if (watch && watch.exitCode === null && watch.signalCode === null) watch.kill();
  watch = undefined;
  for (const pid of recorded) if (alive(pid)) process.kill(pid);
  recorded.clear();
  await pause(300);
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  root = undefined;
});

describe('dev-сторож: поток ошибок сервера в server.log', () => {
  it('stderr сервера — и в поток сторожа, и в server.log построчно со временем', async () => {
    root = mkdtempSync(join(tmpdir(), 'dev-watch-server-log-'));
    const serverDir = join(root, 'apps', 'server');
    const lib = join(serverDir, 'src', 'lib');
    mkdirSync(lib, { recursive: true });
    mkdirSync(join(root, 'packages', 'contracts', 'src'), { recursive: true });
    copyFileSync(DEV_WATCH, join(lib, 'dev-watch.mjs'));
    copyFileSync(PROBE, join(lib, 'dev-boot-probe.mjs'));
    copyFileSync(BRAND, join(lib, 'brand.mjs'));
    copyFileSync(RESTART, join(lib, 'dev-restart.mjs'));
    copyFileSync(HOP_RECORDER, join(lib, 'hop-recorder.mjs'));
    writeFileSync(join(serverDir, 'src', 'index.ts'), FAKE_SERVER);
    const config = join(root, 'config');
    const { appDataDirOf } = (await import(BRAND.href)) as {
      appDataDirOf: (configRoot: string) => string;
    };
    const serverLog = join(appDataDirOf(config), 'server.log');
    const pidsFile = join(root, 'pids.txt');

    let watchStderr = '';
    watch = spawn(process.execPath, [join(lib, 'dev-watch.mjs')], {
      cwd: serverDir,
      env: {
        ...process.env,
        AGENTDECK_DEV_QUIET_MS: '300',
        CLAUDE_CONFIG_DIR: config,
        AGENTDECK_DEV_DEFER: '0',
        PIDS_FILE: pidsFile,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    watch.stdout?.resume();
    watch.stderr?.on('data', (chunk: Buffer) => (watchStderr += chunk.toString()));
    const serverPid = await until(
      () => (existsSync(pidsFile) ? Number(readFileSync(pidsFile, 'utf8').trim()) : undefined),
      30_000,
      `запуск сервера\n${watchStderr}`,
    );
    recorded.add(serverPid);

    const journal = await until(
      () => {
        const text = existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '';
        return text.includes('вторая строка предупреждения') ? text : undefined;
      },
      30_000,
      `server.log\n${watchStderr}`,
    );
    const lines = journal.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \S/);
    expect(lines[0]).toMatch(/Z permission-request: Bash toolu_slow answered in 131 s$/);
    expect(lines[1]).toMatch(/Z вторая строка предупреждения$/);
    // Поток не перехвачен, а раздвоен: тот, кто смотрит терминал сторожа, видит его как есть.
    // Запись в server.log синхронна, а труба stderr на Windows — нет: под нагрузкой файл
    // успевал раньше трубы, и проверка без ожидания краснела на пустом потоке.
    await until(
      () => (watchStderr.includes('вторая строка предупреждения') ? true : undefined),
      30_000,
      `stderr сторожа\n${watchStderr}`,
    );
    expect(watchStderr).toContain('permission-request: Bash toolu_slow answered in 131 s');
    expect(watchStderr).toContain('вторая строка предупреждения');
  }, 60_000);
});
