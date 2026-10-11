import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MobileApkInstallResult,
  MobileApkState,
  MobileApkStatus,
} from '@agentdeck/contracts/mobile-apk';

/** Имя файла сборки — то же, что кладёт `tools/build-mobile-apk.mjs`. */
export const APK_FILE = 'agentdeck.apk';
const STATE_FILE = 'apk-build.json';
const LOG_FILE = 'apk-build.log';
const LOG_LINES = 40;
const LOG_TAIL_BYTES = 64 * 1024;
const RUNNER = fileURLToPath(new URL('./apk-build-runner.mjs', import.meta.url));
// eslint-disable-next-line no-control-regex -- коды цвета Gradle и Expo в логе
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Где лежит репозиторий и куда панель пишет состояние сборки. */
export interface ApkPaths {
  repoRoot: string;
  stateDir: string;
  /** Сборщик; в тестах — подставной скрипт. */
  script?: string;
}

/** Вызов `adb`: подменяется в тестах, в панели — настоящий процесс. */
export type AdbRun = (args: string[], timeoutMs: number) => Promise<string>;

export const runAdb: AdbRun = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('adb', args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(error);
      // `adb install` при отказе выходит с ошибкой, но причина — в выводе.
      resolve(`${stdout}${stderr}`);
    });
  });

const scriptOf = (paths: ApkPaths): string =>
  paths.script ?? join(paths.repoRoot, 'tools', 'build-mobile-apk.mjs');

/** Собирать есть что: сборщик и исходники приложения на месте. */
export function apkBuildAvailable(paths: ApkPaths): boolean {
  return (
    existsSync(scriptOf(paths)) && existsSync(join(paths.repoRoot, 'apps', 'mobile', 'app.json'))
  );
}

interface StoredState {
  state: MobileApkState;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(paths: ApkPaths): StoredState {
  try {
    const stored = JSON.parse(
      readFileSync(join(paths.stateDir, STATE_FILE), 'utf8'),
    ) as StoredState;
    // Запускающий процесс убит (перезагрузка машины, ручное снятие) — итога он
    // уже не напишет. «Собирается» навсегда было бы враньём.
    if (stored.state === 'building' && !alive(stored.pid)) return { ...stored, state: 'failed' };
    return stored;
  } catch {
    return { state: 'idle' };
  }
}

function readLogTail(paths: ApkPaths): string[] {
  const path = join(paths.stateDir, LOG_FILE);
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const length = Math.min(size, LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer
    .toString('utf8')
    .replace(ANSI, '')
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-LOG_LINES);
}

/** Подключённые телефоны по `adb devices`; `undefined` — `adb` нет в PATH. */
export async function adbDevices(adb: AdbRun = runAdb): Promise<string[] | undefined> {
  try {
    const output = await adb(['devices'], 5_000);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(([serial, state]) => serial && state === 'device')
      .map(([serial]) => serial as string);
  } catch {
    return undefined;
  }
}

export async function apkStatus(paths: ApkPaths, adb: AdbRun = runAdb): Promise<MobileApkStatus> {
  const stored = readState(paths);
  const apk = join(paths.repoRoot, APK_FILE);
  const devices = await adbDevices(adb);
  return {
    available: apkBuildAvailable(paths),
    state: stored.state,
    ...(stored.startedAt ? { startedAt: stored.startedAt } : {}),
    ...(stored.finishedAt ? { finishedAt: stored.finishedAt } : {}),
    log: stored.state === 'idle' ? [] : readLogTail(paths),
    ...(existsSync(apk)
      ? {
          file: {
            path: apk,
            size: statSync(apk).size,
            builtAt: statSync(apk).mtime.toISOString(),
          },
        }
      : {}),
    devices: devices ?? [],
    adbMissing: devices === undefined,
  };
}

/**
 * Запуск сборки. `false` — уже идёт или собирать нечего: вторая сборка поверх
 * первой удалила бы её файл посреди работы.
 */
export function startApkBuild(paths: ApkPaths): boolean {
  if (!apkBuildAvailable(paths) || readState(paths).state === 'building') return false;
  const child = spawn(
    process.execPath,
    [
      RUNNER,
      '--script',
      scriptOf(paths),
      '--cwd',
      paths.repoRoot,
      '--log',
      join(paths.stateDir, LOG_FILE),
      '--state',
      join(paths.stateDir, STATE_FILE),
    ],
    { cwd: paths.repoRoot, detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  // Состояние — сразу, а не когда запускающий процесс поднимется: двойной клик
  // за эти миллисекунды запускал вторую сборку поверх первой (тест это поймал).
  // Прежний лог — прочь, чтобы под «собирается» не стоял вывод прошлой сборки.
  writeFileSync(
    join(paths.stateDir, STATE_FILE),
    JSON.stringify({ state: 'building', startedAt: new Date().toISOString(), pid: child.pid }),
  );
  writeFileSync(join(paths.stateDir, LOG_FILE), '');
  return true;
}

/** Поставить готовый APK на телефон по `adb`; телефон должен быть в списке. */
export async function installApk(
  paths: ApkPaths,
  device: string,
  adb: AdbRun = runAdb,
): Promise<MobileApkInstallResult | undefined> {
  const apk = join(paths.repoRoot, APK_FILE);
  const devices = await adbDevices(adb);
  if (!existsSync(apk) || !devices?.includes(device)) return undefined;
  const output = (await adb(['-s', device, 'install', '-r', apk], 180_000)).trim();
  return {
    ok: /^Success$/m.test(output),
    device,
    output: output.split(/\r?\n/).slice(-3).join('\n'),
  };
}
