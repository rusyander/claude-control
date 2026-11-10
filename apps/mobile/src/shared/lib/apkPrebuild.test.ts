import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Сборка APK и файл Firebase (этап 12, M2): `tools/build-mobile-apk.mjs` сам запускает
 * `npx expo prebuild --platform android`, когда задан `AGENTDECK_GOOGLE_SERVICES`, а в
 * `android/app` файла нет или он другой; тот же файл — prebuild не нужен. Настоящий модуль
 * сборки (импорт не запускает сборку), настоящая файловая система во временном каталоге;
 * подменён только запуск процесса — он кладёт файл, как это делает prebuild.
 */

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}
interface ApkModule {
  GOOGLE_SERVICES_ENV: string;
  prebuildNeed(env: Record<string, string>, mobileDir: string): { run: boolean; reason: string };
  ensureGoogleServices(options: {
    env: Record<string, string>;
    mobileDir: string;
    spawn: (
      command: string,
      args: string[],
      options: { cwd: string; shell: boolean },
    ) => {
      status: number | null;
    };
    log: (line: string) => void;
    platform: string;
  }): boolean;
}

const script = fileURLToPath(new URL('../../../../../tools/build-mobile-apk.mjs', import.meta.url));
const apk = (await import(/* @vite-ignore */ pathToFileURL(script).href)) as ApkModule;

const FIREBASE = '{"project_info":{"project_number":"1"}}';

let dir: string;
let mobileDir: string;
let placed: string;
let calls: SpawnCall[];
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-apk-prebuild-'));
  mobileDir = join(dir, 'mobile');
  mkdirSync(mobileDir, { recursive: true });
  writeFileSync(join(dir, 'google-services.json'), FIREBASE);
  placed = join(mobileDir, 'android', 'app', 'google-services.json');
  calls = [];
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Prebuild: кладёт файл из `app.config.js` в `android/app` (или ничего — `copies: false`). */
const prebuild =
  (copies = true, status = 0) =>
  (command: string, args: string[], options: { cwd: string; shell: boolean }) => {
    calls.push({ command, args, cwd: options.cwd, shell: options.shell });
    if (copies) {
      mkdirSync(join(mobileDir, 'android', 'app'), { recursive: true });
      writeFileSync(placed, readFileSync(join(dir, 'google-services.json')));
    }
    return { status };
  };

const env = (): Record<string, string> => ({
  [apk.GOOGLE_SERVICES_ENV]: '../google-services.json',
});

const ensure = (over: Partial<Parameters<ApkModule['ensureGoogleServices']>[0]> = {}) =>
  apk.ensureGoogleServices({
    env: env(),
    mobileDir,
    spawn: prebuild(),
    log: (line) => logs.push(line),
    platform: 'win32',
    ...over,
  });

describe('APK build runs expo prebuild only when the Firebase file is missing or different', () => {
  it('no AGENTDECK_GOOGLE_SERVICES → no prebuild, build goes on', () => {
    expect(apk.prebuildNeed({}, mobileDir)).toEqual({ run: false, reason: 'no-google-services' });
    expect(ensure({ env: {} })).toBe(true);
    expect(calls).toEqual([]);
  });

  it('file absent in android/app → npx expo prebuild --platform android in apps/mobile, then the file is there', () => {
    expect(apk.prebuildNeed(env(), mobileDir)).toMatchObject({ run: true, reason: 'absent' });
    expect(ensure()).toBe(true);
    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['expo', 'prebuild', '--platform', 'android'],
        cwd: mobileDir,
        shell: true,
      },
    ]);
    expect(readFileSync(placed, 'utf8')).toBe(FIREBASE);
  });

  it('a differing file in android/app → prebuild runs; the same file → no prebuild', () => {
    mkdirSync(join(mobileDir, 'android', 'app'), { recursive: true });
    writeFileSync(placed, '{"project_info":{"project_number":"OLD"}}');
    expect(apk.prebuildNeed(env(), mobileDir)).toMatchObject({ run: true, reason: 'differs' });
    expect(ensure()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(readFileSync(placed, 'utf8')).toBe(FIREBASE);

    calls.length = 0;
    expect(apk.prebuildNeed(env(), mobileDir)).toMatchObject({ run: false, reason: 'same' });
    expect(ensure()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('the variable points nowhere, prebuild fails, or prebuild does not place the file → the build stops', () => {
    expect(ensure({ env: { [apk.GOOGLE_SERVICES_ENV]: '../nope.json' } })).toBe(false);
    expect(calls).toEqual([]);
    expect(logs.at(-1)).toContain('файла там нет');

    expect(ensure({ spawn: prebuild(true, 1) })).toBe(false);
    expect(logs.at(-1)).toContain('не отработал');

    rmSync(placed);
    expect(ensure({ spawn: prebuild(false) })).toBe(false);
    expect(logs.at(-1)).toContain('так и не тот');
  });
});
