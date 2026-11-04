import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { supervisionEnabled } from '../../bootstrap/runtime/core-supervisor-wiring.ts';
import { HOP_RECORD_ENV } from '../../lib/hop-recorder.mjs';
import {
  CORE_LOG_FILES,
  CORE_SUPERVISE_ENV,
  coreLaunchArgs,
  coreLaunchEnv,
  launchCore,
} from './launch.ts';

/**
 * Подъём ядра: строка запуска, окружение без переменных панели и настоящий запуск поддельной
 * точки входа обеими дорогами (Windows — скрытый PowerShell, POSIX — отвязанный spawn): вывод
 * ядра ложится в файлы его дома, а `--home` доходит до процесса.
 */

const root = mkdtempSync(join(tmpdir(), 'cc-core-launch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeEntry(): string {
  const dir = join(root, 'core', 'src');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'index.ts');
  writeFileSync(
    entry,
    [
      'const at = process.argv.indexOf("--home");',
      'console.log(JSON.stringify({',
      '  home: process.argv[at + 1],',
      '  port: process.env.PORT ?? null,',
      `  supervise: process.env.${CORE_SUPERVISE_ENV} ?? null,`,
      '  keep: process.env.CC_LAUNCH_KEEP ?? null,',
      '  cwd: process.cwd(),',
      '}));',
      'console.error("core stderr line");',
    ].join('\n'),
  );
  return entry;
}

async function readWhenWritten(file: string, ms = 20_000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // файла ещё нет — процесс только поднимается
    }
    if (text.includes('\n')) return text;
    if (Date.now() > until) throw new Error(`nothing written to ${file}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('core launch line and environment', () => {
  it('the home travels as --home, strip-types on', () => {
    expect(coreLaunchArgs('/x/core/src/index.ts', '/h')).toEqual([
      '--experimental-strip-types',
      '--no-warnings',
      '/x/core/src/index.ts',
      '--home',
      '/h',
    ]);
  });

  it('panel-only variables never reach the core, any case on Windows', () => {
    const env = coreLaunchEnv({
      PORT: '5178',
      web_port: '8888',
      API_PORT: '1',
      [HOP_RECORD_ENV]: '/x',
      [CORE_SUPERVISE_ENV]: '1',
      PATH: '/bin',
      HOME: '/home/me',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' });
  });

  it('supervision is off with AGENTDECK_CORE_SUPERVISE=0 and under vitest', () => {
    expect(supervisionEnabled({})).toBe(true);
    expect(supervisionEnabled({ [CORE_SUPERVISE_ENV]: '1' })).toBe(true);
    expect(supervisionEnabled({ [CORE_SUPERVISE_ENV]: '0' })).toBe(false);
    expect(supervisionEnabled({ VITEST: 'true' })).toBe(false);
  });
});

describe('core launch: a real process writes into the core home', () => {
  const entry = fakeEntry();
  const env = {
    ...process.env,
    PORT: '5178',
    [CORE_SUPERVISE_ENV]: '1',
    CC_LAUNCH_KEEP: 'kept',
  };

  for (const platform of ['win32', 'linux'] as const) {
    it.skipIf(platform === 'win32' && process.platform !== 'win32')(
      `${platform} road: pid, --home, logs, stripped env, cwd = core app`,
      async () => {
        const home = join(root, `home-${platform}`);
        const got = await launchCore({ home, entry, env, platform });
        expect(got.pid).toBeGreaterThan(0);
        const out = JSON.parse((await readWhenWritten(join(home, CORE_LOG_FILES.out))).trim());
        expect(out).toMatchObject({ home, port: null, supervise: null, keep: 'kept' });
        expect(out.cwd.toLowerCase()).toBe(join(root, 'core').toLowerCase());
        expect(await readWhenWritten(join(home, CORE_LOG_FILES.err))).toContain('core stderr line');
        if (platform === 'linux') expect(await got.exited).toMatchObject({ code: 0 });
      },
      40_000,
    );
  }
});
