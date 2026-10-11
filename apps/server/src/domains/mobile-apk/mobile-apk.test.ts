import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  adbDevices,
  apkStatus,
  installApk,
  startApkBuild,
  type AdbRun,
  type ApkPaths,
} from './mobile-apk.ts';

/**
 * Сборка APK кнопкой: настоящий отвязанный запуск (`apk-build-runner.mjs`) над
 * подставным сборщиком — итог должен прийти через файл состояния, а не через
 * память панели, иначе перезапуск панели посреди сборки его бы потерял.
 */

const FAKE_BUILD = fileURLToPath(new URL('./__fixtures__/fake-apk-build.mjs', import.meta.url));
const noAdb: AdbRun = () => Promise.reject(Object.assign(new Error('no adb'), { code: 'ENOENT' }));

let root: string;
let paths: ApkPaths;

async function settled(): Promise<Awaited<ReturnType<typeof apkStatus>>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await apkStatus(paths, noAdb);
    if (status.state !== 'building') return status;
    if (Date.now() > deadline) throw new Error('сборка не закончилась');
    await new Promise((done) => setTimeout(done, 100));
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-apk-'));
  mkdirSync(join(root, 'repo', 'apps', 'mobile'), { recursive: true });
  writeFileSync(join(root, 'repo', 'apps', 'mobile', 'app.json'), '{}');
  mkdirSync(join(root, 'state'));
  paths = { repoRoot: join(root, 'repo'), stateDir: join(root, 'state'), script: FAKE_BUILD };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('mobile-apk', () => {
  it('до первой сборки — idle, без лога и файла; без adb — adbMissing', async () => {
    const status = await apkStatus(paths, noAdb);
    expect(status).toMatchObject({ available: true, state: 'idle', log: [], adbMissing: true });
    expect(status.file).toBeUndefined();
  });

  it('удачная сборка: итог, файл и лог без кодов цвета; вторая поверх идущей — отказ', async () => {
    expect(startApkBuild(paths)).toBe(true);
    expect(startApkBuild(paths)).toBe(false);
    const status = await settled();
    expect(status.state).toBe('succeeded');
    expect(status.finishedAt).toBeDefined();
    expect(status.file?.size).toBe(3);
    expect(status.log).toContain('> Task :app:assembleRelease');
    expect(status.log).toContain('BUILD SUCCESSFUL');
    expect(status.log.join('\n')).not.toContain('\u001b');
  });

  it('упавшая сборка — failed, вывод на месте', async () => {
    writeFileSync(join(paths.repoRoot, 'fail'), '');
    expect(startApkBuild(paths)).toBe(true);
    const status = await settled();
    expect(status.state).toBe('failed');
    expect(status.log).toContain('BUILD FAILED');
  });

  it('запускающий процесс мёртв — не «собирается» навсегда, а failed', async () => {
    writeFileSync(
      join(paths.stateDir, 'apk-build.json'),
      JSON.stringify({ state: 'building', startedAt: '2026-10-11T10:00:00.000Z', pid: 2 ** 22 }),
    );
    expect((await apkStatus(paths, noAdb)).state).toBe('failed');
    expect(startApkBuild(paths)).toBe(true);
    expect((await settled()).state).toBe('succeeded');
  });

  it('без исходников приложения собирать нечего', async () => {
    rmSync(join(paths.repoRoot, 'apps'), { recursive: true });
    expect((await apkStatus(paths, noAdb)).available).toBe(false);
    expect(startApkBuild(paths)).toBe(false);
  });

  it('adb: только устройства в состоянии device; установка — по Success в выводе', async () => {
    const calls: string[][] = [];
    const adb: AdbRun = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') {
        return 'List of devices attached\nSOX4\tdevice\nOFF1\toffline\nUNA\tunauthorized\n\n';
      }
      return 'Performing Streamed Install\nSuccess\n';
    };
    expect(await adbDevices(adb)).toEqual(['SOX4']);
    expect(await adbDevices(noAdb)).toBeUndefined();

    expect(await installApk(paths, 'SOX4', adb)).toBeUndefined(); // файла ещё нет
    writeFileSync(join(paths.repoRoot, 'agentdeck.apk'), 'apk');
    expect(await installApk(paths, 'OFF1', adb)).toBeUndefined(); // не в состоянии device
    const result = await installApk(paths, 'SOX4', adb);
    expect(result).toMatchObject({ ok: true, device: 'SOX4' });
    expect(calls.at(-1)).toEqual([
      '-s',
      'SOX4',
      'install',
      '-r',
      join(paths.repoRoot, 'agentdeck.apk'),
    ]);

    const refused: AdbRun = async (args) =>
      args[0] === 'devices'
        ? 'SOX4\tdevice\n'
        : 'Performing Streamed Install\nadb: failed to install: INSTALL_FAILED_UPDATE_INCOMPATIBLE\n';
    expect(await installApk(paths, 'SOX4', refused)).toMatchObject({ ok: false });
  });
});
