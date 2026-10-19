import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Окно приложения при старте Windows: сторож открывает его раз за загрузку, никогда вкладкой. */
const MODULE = resolve(__dirname, '../../../../tools/keepalive-app.mjs');

type Launch = { command: string; args: string[]; how: string } | null;
const app = (await import(pathToFileURL(MODULE).href)) as {
  APP_URL: string;
  bootTime: (now: number, uptimeSec: number) => number;
  openedThisBoot: (marker: string, bootAt: number) => boolean;
  readMarker: (dir: string) => string;
  writeMarker: (dir: string, bootAt: number) => void;
  setOpenApp: (dir: string, on: boolean) => void;
  openAppEnabled: (dir: string) => boolean;
  resolveAppLaunch: (env: Record<string, string>, exists: (path: string) => boolean) => Launch;
};

const ENV = {
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keepalive-app-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('keepalive-app', () => {
  it('отметка загрузки: та же загрузка — уже открывали, следующая — открыть снова', () => {
    const bootAt = app.bootTime(1_000_000_000, 3600);
    expect(app.readMarker(dir)).toBe('');
    expect(app.openedThisBoot(app.readMarker(dir), bootAt)).toBe(false);

    app.writeMarker(dir, bootAt);
    // Подхват через 5 минут: uptime вырос на столько же, момент загрузки тот же.
    const sameBoot = app.bootTime(1_000_000_000 + 300_000, 3600 + 300);
    expect(app.openedThisBoot(app.readMarker(dir), sameBoot)).toBe(true);

    // Перезагрузка: момент загрузки сдвинулся на часы вперёд.
    const nextBoot = app.bootTime(1_000_000_000 + 7_200_000, 60);
    expect(app.openedThisBoot(app.readMarker(dir), nextBoot)).toBe(false);
    expect(app.openedThisBoot('мусор', bootAt)).toBe(false);
  });

  it('флаг окна включается и снимается', () => {
    expect(app.openAppEnabled(dir)).toBe(false);
    app.setOpenApp(dir, true);
    expect(app.openAppEnabled(dir)).toBe(true);
    app.setOpenApp(dir, false);
    expect(app.openAppEnabled(dir)).toBe(false);
    // Снять уже снятое — не ошибка.
    app.setOpenApp(dir, false);
  });

  it('ярлык установленного приложения важнее браузера с --app', () => {
    const shortcut = join(
      ENV.APPDATA,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Chrome Apps',
      'AgentDeck.lnk',
    );
    const edge = join(ENV['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const both = app.resolveAppLaunch(ENV, (path) => path === shortcut || path === edge);
    expect(both?.command).toBe(join(ENV.SystemRoot, 'explorer.exe'));
    expect(both?.args).toEqual([shortcut]);

    const onlyEdge = app.resolveAppLaunch(ENV, (path) => path === edge);
    expect(onlyEdge?.command).toBe(edge);
    expect(onlyEdge?.args).toEqual([`--app=${app.APP_URL}`]);
  });

  it('нечем открыть окно — null, а не вкладка браузера', () => {
    expect(app.resolveAppLaunch(ENV, () => false)).toBeNull();
  });
});
