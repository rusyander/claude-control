import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { CORE_BUSY_EXIT_ENV, CORE_HOME_BUSY_EXIT } from '@agentdeck/contracts/core/supervisor';
import { launchdPlist, systemdUnit } from '../platform/keepalive.ts';
import { system32, type ToolRun } from '../platform/run-tool.ts';
import {
  busyExitCode,
  coreKeepaliveSpec,
  homeFromArgv,
  parseKeepaliveArgs,
  runKeepaliveCommand,
} from './keepalive-command.ts';

/**
 * Автозапуск ядра командой процесса ядра (P57): `index.ts keepalive …`. Живая проверка на
 * Windows ставит НАСТОЯЩУЮ задачу Планировщика с одноразовым именем `agentdeck-p57-<pid>-<ms>`
 * (выключенную — при входе она не сработает), читает её назад, снимает и проверяет, что её нет;
 * `afterAll` снимает остаток и тоже проверяет.
 */

const ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
const TASK = `agentdeck-p57-${process.pid}-${Date.now()}`;

function run(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const core = (args: string[]) =>
  run(process.execPath, ['--experimental-strip-types', '--no-warnings', ENTRY, ...args]);
const query = () => run(system32('schtasks.exe'), ['/Query', '/TN', TASK, '/XML']);

afterAll(async () => {
  if (process.platform !== 'win32') return;
  if ((await query()).code === 0)
    await run(system32('schtasks.exe'), ['/Delete', '/TN', TASK, '/F']);
  expect((await query()).code).not.toBe(0);
});

describe('core keepalive command (P57)', () => {
  it('parses install/remove/status with name, home and disabled; refuses anything else', () => {
    expect(
      parseKeepaliveArgs(['install', '--name', 'x-1', '--home', 'C:/h', '--disabled']),
    ).toEqual({ action: 'install', name: 'x-1', home: 'C:/h', enabled: false });
    expect(parseKeepaliveArgs(['status'])).toMatchObject({ action: 'status', enabled: true });
    expect(parseKeepaliveArgs(['start'])).toHaveProperty('error');
    expect(parseKeepaliveArgs(['install', '--name'])).toHaveProperty('error');
    expect(parseKeepaliveArgs(['install', '--force'])).toHaveProperty('error');
    expect(homeFromArgv(['--home', '/core/home'])).toBe('/core/home');
    expect(homeFromArgv(['--home'])).toBeUndefined();
  });

  it('the autostart entry runs THIS core: absolute node, index.ts, --home of the core home', () => {
    const spec = coreKeepaliveSpec({ name: 'n', home: '/core/home', enabled: true });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      '--experimental-strip-types',
      '--no-warnings',
      ENTRY,
      '--home',
      '/core/home',
    ]);
  });

  it('the autostart entry tells the core to leave a busy home with 0, so systemd/launchd never respawn the extra core', () => {
    const spec = coreKeepaliveSpec({ name: 'n', home: '/core/home', enabled: true });
    expect(spec.env).toEqual({ [CORE_BUSY_EXIT_ENV]: '0' });
    // Пути — POSIX-образные: на Windows путь ядра в юнит systemd не ложится, проверяется окружение.
    const posix = { ...spec, command: '/usr/bin/node', args: ['index.ts'], cwd: '/opt/core' };
    expect(systemdUnit(posix)).toContain(`Environment="${CORE_BUSY_EXIT_ENV}=0"`);
    expect(launchdPlist(posix)).toContain(`<key>${CORE_BUSY_EXIT_ENV}</key>`);
    expect(busyExitCode({ [CORE_BUSY_EXIT_ENV]: '0' })).toBe(0);
    expect(busyExitCode({})).toBe(CORE_HOME_BUSY_EXIT);
    expect(busyExitCode({ [CORE_BUSY_EXIT_ENV]: '1' })).toBe(CORE_HOME_BUSY_EXIT);
  });

  it('a refused registration is exit 1 with the reason, never a silent success', async () => {
    const err: string[] = [];
    const refused: ToolRun = {
      ok: false,
      reason: 'exit 1',
      timedOut: false,
      stderr: 'Access is denied.',
    };
    const code = await runKeepaliveCommand(['install', '--name', 'n', '--home', 'C:/h'], {
      out: () => undefined,
      err: (line) => err.push(line),
      deps: {
        os: 'win32',
        user: 'D\\u',
        scratchDir: tempDir('ka-'),
        run: async () => refused,
      },
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Access is denied.');
    expect(
      await runKeepaliveCommand(['bogus'], { out: () => undefined, err: () => undefined }),
    ).toBe(2);
  });

  it.runIf(process.platform === 'win32')(
    'live Windows: index.ts keepalive installs a real Task Scheduler task, status reads it, remove leaves none',
    async () => {
      const home = join(tempDir('ka-home-'), 'core');
      const installed = await core([
        'keepalive',
        'install',
        '--name',
        TASK,
        '--home',
        home,
        '--disabled',
      ]);
      expect(installed.code, installed.stderr).toBe(0);
      const xml = await query();
      expect(xml.code, xml.stderr).toBe(0);
      expect(xml.stdout).toContain(ENTRY);
      expect(xml.stdout).toContain(home);
      expect(xml.stdout).toContain('<Enabled>false</Enabled>');
      expect((await core(['keepalive', 'status', '--name', TASK])).code).toBe(0);
      const removed = await core(['keepalive', 'remove', '--name', TASK]);
      expect(removed.code, removed.stderr).toBe(0);
      expect((await query()).code).not.toBe(0);
      expect((await core(['keepalive', 'status', '--name', TASK])).code).toBe(1);
    },
    120_000,
  );
});
