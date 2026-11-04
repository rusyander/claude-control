import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { killLeftovers, readProcessTable } from './kill-tree.mjs';
import { removeEntry } from './safe-io/safe-io.ts';

/**
 * Отвязанные процессы ядра уходят со стендом (этап 10, зона C, проход 6) — настоящие процессы:
 * хост сессии `apps/core/src/session-host/main.ts` и хост звеньев `apps/core/src/hop-host/main.ts`,
 * запущенные отвязанными, как их запускает ядро.
 *
 * 1. Стенд (`throwaway-stand.mjs`): хост, которого ядро успело запустить, а `host.json` он пишет
 *    сам уже после начала снятия. Однократное чтение записей его пропускало — хост с CLI жил после
 *    стенда (`cc-agent-images-*`, 03.11).
 * 2. Стенд съёмки (`help-shots/linked-stand.mjs`): панель с подменённым домом поднимает своё ядро,
 *    оно — хост звеньев; снос стенда хоста не снимал (девять `cc-help-*`, 03.11).
 *
 * `STAND_SRC` / `LINKED_SRC` — модули под проверкой (прежний код для «красного до»). Все процессы
 * теста снимаются по записанным личностям и только живые.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const modUrl = (env: string | undefined, ...rel: string[]): string =>
  pathToFileURL(env ? resolve(env) : join(REPO, ...rel)).href;
const HOST_MAIN = join(REPO, 'apps', 'core', 'src', 'session-host', 'main.ts');
const HOP_MAIN = join(REPO, 'apps', 'core', 'src', 'hop-host', 'main.ts');
const IS_WIN = process.platform === 'win32';

interface StandApi {
  root: string;
  coreHome: string;
  stop(): Promise<{ left: unknown[]; removeError?: string } | undefined>;
}
const stand = (await import(
  modUrl(process.env.STAND_SRC, 'tools', 'qa', 'throwaway-stand.mjs')
)) as {
  startStand(options: Record<string, unknown>): Promise<StandApi>;
};
const linked = (await import(
  modUrl(process.env.LINKED_SRC, 'tools', 'help-shots', 'linked-stand.mjs')
)) as {
  makeLinkedStand(stand: string, prefix: string, owner: string): string;
  dropLinkedStand(stand: string, prefix: string): void;
};

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const mine = new Map<number, bigint>();
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'stand-settle-'));
dirs.push(scratch);

function createdOf(pid: number): bigint | undefined {
  return readProcessTable()?.find((r) => r.pid === pid)?.created;
}
function alive(pid: number, created: bigint): boolean {
  return createdOf(pid) === created;
}
async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error('timed out');
    await pause(100);
  }
}
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Хост сессии так, как его запускает ядро (`session-host/launch.ts`): `spec.json` + `token`,
 * процесс отвязан, рабочая папка — корень тома. «CLI» пишет свой номер в файл ВНЕ стенда —
 * по нему CLI находится и после сноса каталога сессии. Ответ — номер и время создания хоста и
 * путь к файлу номера CLI.
 */
function launchHost(sessionDir: string, releaseFile?: string) {
  mkdirSync(sessionDir, { recursive: true });
  const tag = randomBytes(4).toString('hex');
  const pidFile = join(scratch, `cli-${tag}.pid`);
  const cli = join(scratch, `cli-${tag}.mjs`);
  writeFileSync(
    cli,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  );
  const channel = IS_WIN
    ? `\\\\.\\pipe\\stand-settle-${tag}`
    : join(mkdtempSync(join(tmpdir(), 'ss-')), 'h.sock');
  writeFileSync(join(sessionDir, 'token'), randomBytes(24).toString('hex'));
  writeFileSync(
    join(sessionDir, 'spec.json'),
    JSON.stringify({
      v: 1,
      sessionId: `s-settle-${tag}`,
      command: process.execPath,
      args: [cli],
      cwd: scratch,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      channel,
    }),
  );
  const hold = releaseFile ? ['--import', pathToFileURL(HOLD).href] : [];
  const host = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', ...hold, HOST_MAIN, sessionDir],
    {
      cwd: parse(sessionDir).root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, STAND_SETTLE_RELEASE: releaseFile ?? '' },
    },
  );
  host.unref();
  const created = createdOf(host.pid!);
  if (created === undefined) throw new Error('host not in the snapshot');
  mine.set(host.pid!, created);
  return { pid: host.pid!, created, pidFile };
}

/**
 * Предзагрузка хоста «ещё поднимается»: модули хоста уже загружены, а `runHost` (чтение
 * `spec.json`, запуск CLI, запись `host.json`) ждёт времени из файла `STAND_SETTLE_RELEASE`.
 * Тест ставит это время так, чтобы прежнее однократное снятие уже прошло, а каталог ещё не был
 * удалён, — то же окно, в котором хост, запущенный умирающим ядром, переживал стенд.
 */
const HOLD = join(scratch, 'hold-host.mjs');
const HOST_TS = pathToFileURL(join(REPO, 'apps', 'core', 'src', 'session-host', 'host.ts')).href;
writeFileSync(
  HOLD,
  [
    "import { readFileSync } from 'node:fs';",
    `await import(${JSON.stringify(HOST_TS)});`,
    'const file = process.env.STAND_SETTLE_RELEASE;',
    'for (;;) {',
    '  let at = Infinity;',
    "  try { at = Number(readFileSync(file, 'utf8')) || Infinity; } catch {}",
    '  if (Date.now() >= at) break;',
    '  await new Promise((done) => setTimeout(done, 10));',
    '}',
    '',
  ].join('\n'),
);

/** CLI хоста по его файлу номера (ждёт, пока CLI поднимется). */
async function cliOf(pidFile: string): Promise<{ pid: number; created: bigint }> {
  const pid = await until(() => {
    const n = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : '');
    return Number.isInteger(n) && n > 0 ? n : undefined;
  });
  const created = await until(() => createdOf(pid));
  mine.set(pid, created);
  return { pid, created };
}

afterAll(async () => {
  killLeftovers(mine, { slackMs: 0 });
  await pause(500);
  for (const dir of dirs) removeEntry(dir);
});

describe.runIf(IS_WIN)('detached core processes leave with the stand (real hosts)', () => {
  it('stand stop() while a session host is still starting: the host and its CLI are reaped', async () => {
    const api = await stand.startStand({ label: 'settle', web: false, core: true });
    dirs.push(api.root);
    const session = join(api.coreHome, 'tasks', 't-settle', 'sessions', 's-settle');
    // Хост запущен, но `host.json` ещё нет: снятие начинается, пока он поднимается. Отпускаем его
    // через 1,8 с после начала снятия — прежнее однократное снятие к этому времени уже прочло
    // записи (синхронная часть его `stop()` — ~1,78 с), а каталог удаляет только через 0,5 с.
    // Хост удаляет `spec.json`, прочитав его, и лишь потом пишет `host.json` — это окно и ловится.
    const release = join(scratch, 'release-a');
    const host = launchHost(session, release);
    await pause(1500);
    writeFileSync(release, String(Date.now() + 1800));
    const outcome = await api.stop();
    const cli = await cliOf(host.pidFile).catch(() => undefined);

    expect(alive(host.pid, host.created)).toBe(false);
    if (cli) expect(alive(cli.pid, cli.created)).toBe(false);
    expect(outcome?.left).toEqual([]);
  }, 240_000);

  it('help-shots linked stand: dropping it stops the hop host and the session host recorded under it', async () => {
    const at = join(scratch, 'claude-demo-settle');
    const prefix = 'cc-help-settle-';
    linked.makeLinkedStand(at, prefix, 'throwaway-stand-settle.process.test.ts');
    const coreHome = join(at, 'home', '.agentdeck', 'core');
    mkdirSync(coreHome, { recursive: true });
    const arg = Buffer.from(JSON.stringify({ home: coreHome }), 'utf8').toString('base64url');
    const hop = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', HOP_MAIN, arg],
      {
        cwd: parse(coreHome).root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    hop.unref();
    const hopCreated = await until(() => createdOf(hop.pid!));
    mine.set(hop.pid!, hopCreated);
    // Хост звеньев записал себя в `procs.json` дома — так его находит и ядро.
    await until(() => {
      const servers = (readJson(join(coreHome, 'procs.json')) as { servers?: { pid?: number }[] })
        ?.servers;
      return servers?.some((row) => row.pid === hop.pid) ? true : undefined;
    });
    const host = launchHost(join(coreHome, 'tasks', 't', 'sessions', 's'));
    await until(() =>
      existsSync(join(coreHome, 'tasks', 't', 'sessions', 's', 'host.json')) ? true : undefined,
    );
    const cli = await cliOf(host.pidFile);
    expect(alive(hop.pid!, hopCreated)).toBe(true);

    linked.dropLinkedStand(at, prefix);

    expect(alive(hop.pid!, hopCreated)).toBe(false);
    expect(alive(host.pid, host.created)).toBe(false);
    expect(alive(cli.pid, cli.created)).toBe(false);
    expect(existsSync(at)).toBe(false);
  }, 240_000);
});
