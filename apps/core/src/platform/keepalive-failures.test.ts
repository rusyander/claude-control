import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  installKeepalive,
  lingerState,
  parseLinger,
  removeKeepalive,
  taskSchedulerXml,
  validateKeepalive,
  type KeepaliveSpec,
} from './keepalive.ts';
import { system32, type ToolRun } from './run-tool.ts';

/**
 * Отказы автозапуска ядра (P57): каждый шаг ОС, который не прошёл, назван в причине со своим
 * stderr; временный XML задачи Windows не остаётся на диске ни при успехе, ни при отказе;
 * невнятный ответ ОС — `unknown`/заметка, никогда не «включено». Подменяется только запуск
 * средств ОС (`run`), файлы пишутся по-настоящему.
 */

const root = mkdtempSync(join(tmpdir(), 'keepalive fail ü '));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const SPEC: KeepaliveSpec = {
  name: 'core-keepalive',
  description: 'Core',
  command: '/opt/node',
  args: [],
  cwd: '/home/u',
};
const ok = (stdout = ''): ToolRun => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false });
const fail = (reason: string, stderr = ''): ToolRun => ({
  ok: false,
  reason,
  timedOut: false,
  stderr,
});

function recorder(answers: Record<string, ToolRun>, onCall?: (line: string) => void) {
  const calls: string[] = [];
  const run = async (file: string, args: readonly string[]) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    onCall?.(line);
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return key ? (answers[key] as ToolRun) : ok();
  };
  return { calls, run };
}

describe('P57 keepalive — Windows Task Scheduler', () => {
  it('P57 Windows install: no user name → refused before any schtasks call', async () => {
    const { calls, run } = recorder({});
    expect(
      await installKeepalive(SPEC, { os: 'win32', home: 'C:\\h', user: '', run, scratchDir: root }),
    ).toEqual({ ok: false, reason: 'no user name for the logon trigger', notes: [] });
    expect(calls).toEqual([]);
  });

  it('P57 Windows install: user from USERDOMAIN\\USERNAME; the XML handed to schtasks is UTF-16 with the logon trigger, and is gone after success and after a refusal (stderr named)', async () => {
    vi.stubEnv('USERDOMAIN', 'PC');
    vi.stubEnv('USERNAME', 'u');
    const scratch = mkdtempSync(join(root, 'xml-'));
    let seen = '';
    const { run } = recorder({}, (line) => {
      const xml = /\/XML (.+?) \/F$/.exec(line)?.[1];
      if (xml) seen = readFileSync(xml).subarray(2).toString('utf16le');
    });
    const done = await installKeepalive(SPEC, {
      os: 'win32',
      home: 'C:\\h',
      run,
      scratchDir: scratch,
    });
    expect(done).toEqual({ ok: true, path: '\\core-keepalive', notes: [] });
    expect(seen).toBe(taskSchedulerXml(SPEC, 'PC\\u'));
    expect(readdirSync(scratch)).toEqual([]);

    const refusing = recorder({
      [system32('schtasks.exe')]: fail('exit 1', 'ERROR: Access is denied.\n'),
    });
    expect(
      await installKeepalive(SPEC, {
        os: 'win32',
        home: 'C:\\h',
        user: 'PC\\u',
        run: refusing.run,
        scratchDir: scratch,
      }),
    ).toEqual({ ok: false, reason: 'schtasks /Create: ERROR: Access is denied.', notes: [] });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('P57 Windows install without USERDOMAIN: the bare USERNAME is the trigger user', async () => {
    vi.stubEnv('USERDOMAIN', '');
    vi.stubEnv('USERNAME', 'solo');
    let seen = '';
    const { run } = recorder({}, (line) => {
      const xml = /\/XML (.+?) \/F$/.exec(line)?.[1];
      if (xml) seen = readFileSync(xml).subarray(2).toString('utf16le');
    });
    await installKeepalive(SPEC, { os: 'win32', home: 'C:\\h', run, scratchDir: root });
    expect(seen).toContain('<UserId>solo</UserId>');
  });

  it('P57 Windows remove: schtasks /Delete ok → removed; refused → reason named; a name outside the pattern → refused without a call', async () => {
    const { calls, run } = recorder({});
    expect(
      await removeKeepalive('core-keepalive', { os: 'win32', home: 'C:\\h', user: 'u', run }),
    ).toEqual({ ok: true, path: '\\core-keepalive', notes: [] });
    expect(calls).toEqual([`${system32('schtasks.exe')} /Delete /TN core-keepalive /F`]);
    const refusing = recorder({ [system32('schtasks.exe')]: fail('spawn schtasks ENOENT') });
    expect(
      await removeKeepalive('core-keepalive', {
        os: 'win32',
        home: 'C:\\h',
        user: 'u',
        run: refusing.run,
      }),
    ).toEqual({ ok: false, reason: 'schtasks /Delete: spawn schtasks ENOENT', notes: [] });
    const none = recorder({});
    expect(await removeKeepalive('../evil', { os: 'win32', run: none.run })).toEqual({
      ok: false,
      reason: 'keepalive name not allowed: ../evil',
      notes: [],
    });
    expect(none.calls).toEqual([]);
  });
});

describe('P57 keepalive — systemd and launchd refusals', () => {
  it('P57 Linux install: enabled:false → enable without --now; a failing daemon-reload stops the install with its stderr', async () => {
    const home = mkdtempSync(join(root, 'off-'));
    const off = recorder({ 'loginctl show-user': ok('yes\n') });
    const outcome = await installKeepalive(
      { ...SPEC, enabled: false },
      { os: 'linux', home, user: 'u', run: off.run },
    );
    expect(outcome).toMatchObject({ ok: true, notes: [] });
    expect(off.calls).toContain('systemctl --user enable core-keepalive.service');
    const broken = recorder({
      'systemctl --user daemon-reload': fail('exit 1', 'Failed to connect to bus\n'),
    });
    expect(await installKeepalive(SPEC, { os: 'linux', home, user: 'u', run: broken.run })).toEqual(
      {
        ok: false,
        reason: 'systemctl --user daemon-reload: Failed to connect to bus',
        notes: [],
      },
    );
  });

  it('P57 linger answer that is neither yes nor no → unknown with the text, and the install names the linger command', async () => {
    expect(parseLinger(' maybe ')).toBeUndefined();
    expect(parseLinger('NO\n')).toBe(false);
    const garbled = recorder({ loginctl: ok('maybe\n') });
    expect(await lingerState('u', garbled.run)).toEqual({ unknown: 'loginctl: «maybe»' });
    const home = mkdtempSync(join(root, 'linger-'));
    const outcome = await installKeepalive(SPEC, {
      os: 'linux',
      home,
      user: 'u',
      run: garbled.run,
    });
    expect(outcome).toMatchObject({
      ok: true,
      notes: [expect.stringContaining('loginctl enable-linger u')],
    });
  });

  it('P57 Linux remove: a failing disable still removes the unit file and names the failure as a note', async () => {
    const home = mkdtempSync(join(root, 'rm-'));
    await installKeepalive(SPEC, { os: 'linux', home, user: 'u', run: recorder({}).run });
    const unit = `${home}/.config/systemd/user/core-keepalive.service`;
    expect(existsSync(unit)).toBe(true);
    const { run } = recorder({ 'systemctl --user disable': fail('exit 5', 'Unit not loaded\n') });
    expect(await removeKeepalive('core-keepalive', { os: 'linux', home, user: 'u', run })).toEqual({
      ok: true,
      path: unit,
      notes: ['unregister: Unit not loaded'],
    });
    expect(existsSync(unit)).toBe(false);
  });

  it('P57 macOS: launchctl bootstrap refused → reason named; no uid → refused before writing', async () => {
    const home = mkdtempSync(join(root, 'mac-'));
    const { run } = recorder({ 'launchctl bootstrap': fail('exit 5', 'Bootstrap failed: 5\n') });
    expect(await installKeepalive(SPEC, { os: 'darwin', home, user: 'u', uid: 501, run })).toEqual({
      ok: false,
      reason: 'launchctl bootstrap: Bootstrap failed: 5',
      notes: [],
    });
    if (typeof process.getuid !== 'function') {
      const bare = mkdtempSync(join(root, 'mac-nouid-'));
      expect(await installKeepalive(SPEC, { os: 'darwin', home: bare, user: 'u', run })).toEqual({
        ok: false,
        reason: 'no uid for launchctl',
        notes: [],
      });
      expect(readdirSync(bare)).toEqual([]);
    }
  });

  it('P57 validation per OS: plutil -lint on macOS, schtasks /Query by task name on Windows; tool answered → valid', async () => {
    const { calls, run } = recorder({});
    expect(await validateKeepalive('/p.plist', 'darwin', run)).toEqual({ value: true });
    expect(await validateKeepalive('\\core-keepalive', 'win32', run)).toEqual({ value: true });
    expect(calls).toEqual([
      'plutil -lint /p.plist',
      `${system32('schtasks.exe')} /Query /TN core-keepalive /XML`,
    ]);
  });
});
