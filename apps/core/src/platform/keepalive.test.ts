import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cronLine,
  installKeepalive,
  launchdPlist,
  lingerState,
  removeKeepalive,
  renderKeepalive,
  systemdUnit,
  validateKeepalive,
  type KeepaliveSpec,
} from './keepalive.ts';
import { runTool, system32, type ToolRun } from './run-tool.ts';

/** Имя задачи живой пробы: `<префикс><pid прогона>-<время создания, мс>`. */
const PROBE_PREFIX = 'agentdeck-p57-';
const STALE_AFTER_MS = 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, но чужой.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Снимает задачи пробы, оставленные убитым прогоном: процесс-создатель мёртв или задаче больше
 * часа. Только корень Планировщика и только этот префикс — чужие задачи не трогаются.
 */
async function sweepStaleProbeTasks(): Promise<string[]> {
  const list = await runTool(system32('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH']);
  if (!list.ok) throw new Error(`schtasks query: ${list.reason}`);
  const swept: string[] = [];
  for (const line of list.stdout.split(/\r?\n/)) {
    const found = /^"\\(agentdeck-p57-(\d+)-(\d+))"/.exec(line);
    if (!found) continue;
    const [, task = '', pid = '0', created = '0'] = found;
    if (pidAlive(Number(pid)) && Date.now() - Number(created) < STALE_AFTER_MS) continue;
    const removed = await runTool(system32('schtasks.exe'), ['/Delete', '/TN', task, '/F']);
    if (!removed.ok) throw new Error(`schtasks delete ${task}: ${removed.reason}`);
    swept.push(task);
  }
  return swept;
}

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'keepalive ü '));
});

const SPEC: KeepaliveSpec = {
  name: 'core-keepalive',
  description: 'Core & <boot> 100%',
  command: '/opt/core dir/node',
  args: ['--flag=a b', 'say "hi"', 'cost $5', 'back\\slash', "it's", '100%'],
  cwd: '/home/u/core %h',
  env: { CORE_HOME: '/home/u/.core home' },
};

const ok = (stdout = ''): ToolRun => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false });
const fail = (reason: string, stderr = ''): ToolRun => ({
  ok: false,
  reason,
  timedOut: false,
  stderr,
});

function recorder(answers: Record<string, ToolRun>) {
  const calls: string[] = [];
  const run = async (file: string, args: readonly string[]) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return key ? (answers[key] as ToolRun) : ok();
  };
  return { calls, run };
}

describe('P57 keepalive files per OS — generated, validated, removed', () => {
  it('P57 systemd user unit: quoting of spaces, quotes, $, %, backslash; content snapshot', () => {
    expect(systemdUnit(SPEC)).toBe(
      [
        '[Unit]',
        'Description=Core & <boot> 100%%',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart="/opt/core dir/node" "--flag=a b" "say \\"hi\\"" "cost $$5" "back\\\\slash" "it\'s" "100%%"',
        'WorkingDirectory=/home/u/core %%h',
        'Environment="CORE_HOME=/home/u/.core home"',
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  it('P57 no systemd → the @reboot crontab line is named with sh quoting and % escaped', () => {
    expect(cronLine({ ...SPEC, args: ["it's", '50%'], env: {} })).toBe(
      "@reboot cd '/home/u/core \\%h' && '/opt/core dir/node' 'it'\\''s' '50\\%'",
    );
  });

  it('P57 launchd plist: escaped XML, argv order kept, RunAtLoad follows enabled', () => {
    const plist = launchdPlist(SPEC);
    expect(plist).toContain('<key>Label</key><string>core-keepalive</string>');
    expect(plist).toContain('<string>say &quot;hi&quot;</string>');
    expect(plist).toContain('<string>it&apos;s</string>');
    expect(plist.indexOf('/opt/core dir/node')).toBeLessThan(plist.indexOf('--flag=a b'));
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(launchdPlist({ ...SPEC, enabled: false })).toContain('<key>RunAtLoad</key><false/>');
  });

  it('P57 Task Scheduler XML: UTF-16LE with BOM on disk, escaped, Windows argv quoting', () => {
    const file = renderKeepalive(SPEC, 'win32', { home: 'C:\\Users\\u', user: 'PC\\u & co' });
    expect([...file.bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(file.bytes.subarray(2).toString('utf16le')).toBe(file.text);
    expect(file.path).toBe('\\core-keepalive');
    expect(file.text).toContain('<UserId>PC\\u &amp; co</UserId>');
    expect(file.text).toContain('<Description>Core &amp; &lt;boot&gt; 100%</Description>');
    expect(file.text).toContain(
      '<Arguments>&quot;--flag=a b&quot; &quot;say \\&quot;hi\\&quot;&quot;',
    );
    expect(file.text).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(() =>
      renderKeepalive({ ...SPEC, name: 'bad name/..' }, 'linux', { home: '/h', user: 'u' }),
    ).toThrow(/not allowed/);
  });

  it('P57 Linux install: unit written, daemon-reload + enable --now, linger absent → named with the command', async () => {
    const home = mkdtempSync(join(root, 'home-'));
    const { calls, run } = recorder({ 'loginctl show-user': ok('no\n') });
    const outcome = await installKeepalive(SPEC, { os: 'linux', home, user: 'u', run });
    const unit = `${home}/.config/systemd/user/core-keepalive.service`;
    expect(outcome).toEqual({
      ok: true,
      path: unit,
      notes: [expect.stringContaining('`loginctl enable-linger u`')],
    });
    expect(readFileSync(unit, 'utf8')).toBe(systemdUnit(SPEC));
    expect(calls).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now core-keepalive.service',
      'loginctl show-user u --property=Linger --value',
    ]);
    const removed = await removeKeepalive('core-keepalive', { os: 'linux', home, user: 'u', run });
    expect(removed.ok).toBe(true);
    expect(existsSync(unit)).toBe(false);
    expect(calls.slice(4)).toEqual([
      'systemctl --user disable --now core-keepalive.service',
      'systemctl --user daemon-reload',
    ]);
  });

  it('P57 Linux without systemd → not installed, nothing written, crontab line named', async () => {
    const home = mkdtempSync(join(root, 'nosd-'));
    const { run } = recorder({
      'systemctl --user show-environment': fail('spawn systemctl ENOENT'),
    });
    const outcome = await installKeepalive(SPEC, { os: 'linux', home, user: 'u', run });
    expect(outcome).toMatchObject({ ok: false, notes: [expect.stringContaining('@reboot cd ')] });
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  it('P57 linger read: yes → true; loginctl absent → unknown, never «on»', async () => {
    expect(await lingerState('u', recorder({ loginctl: ok('yes\n') }).run)).toEqual({
      value: true,
    });
    expect(
      await lingerState('u', recorder({ loginctl: fail('spawn loginctl ENOENT') }).run),
    ).toEqual({
      unknown: 'loginctl: spawn loginctl ENOENT',
    });
  });

  it('P57 macOS install/remove: plist in LaunchAgents, bootstrap / bootout in the gui domain', async () => {
    const home = mkdtempSync(join(root, 'mac-'));
    const { calls, run } = recorder({});
    const outcome = await installKeepalive(SPEC, { os: 'darwin', home, user: 'u', uid: 501, run });
    const plist = `${home}/Library/LaunchAgents/core-keepalive.plist`;
    expect(outcome).toEqual({ ok: true, path: plist, notes: [] });
    expect(readFileSync(plist, 'utf8')).toBe(launchdPlist(SPEC));
    await removeKeepalive('core-keepalive', { os: 'darwin', home, user: 'u', uid: 501, run });
    expect(calls).toEqual([
      // Переустановка поверх загруженной задачи: сначала bootout (F-111).
      'launchctl bootout gui/501/core-keepalive',
      `launchctl bootstrap gui/501 ${plist}`,
      'launchctl bootout gui/501/core-keepalive',
    ]);
    expect(existsSync(plist)).toBe(false);
  });

  it('P57 validation tool absent → unknown named, never «valid»', async () => {
    const run = recorder({ 'systemd-analyze': fail('spawn systemd-analyze ENOENT') }).run;
    expect(await validateKeepalive('/x.service', 'linux', run)).toEqual({
      unknown: 'systemd-analyze: spawn systemd-analyze ENOENT',
    });
  });

  const hasSystemdAnalyze = (() => {
    if (process.platform !== 'linux') return false;
    try {
      execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(hasSystemdAnalyze)(
    'P57 Linux live: systemd-analyze verify accepts the generated unit',
    async () => {
      const dir = mkdtempSync(join(root, 'verify-'));
      const file = join(dir, 'core-keepalive.service');
      writeFileSync(file, systemdUnit({ ...SPEC, command: process.execPath, cwd: dir }));
      expect(await validateKeepalive(file, 'linux', runTool)).toEqual({ value: true });
    },
  );

  it.runIf(process.platform === 'darwin')(
    'P57 macOS live: plutil -lint accepts the generated plist',
    async () => {
      const file = join(mkdtempSync(join(root, 'plist-')), 'core-keepalive.plist');
      writeFileSync(file, launchdPlist(SPEC));
      expect(await validateKeepalive(file, 'darwin', runTool)).toEqual({ value: true });
    },
  );

  describe.runIf(process.platform === 'win32')('P57 Windows live', () => {
    const name = `${PROBE_PREFIX}${process.pid}-${Date.now()}`;
    // Живой тест пишет настоящую задачу Планировщика (F-123). Она выключена, имя уникально,
    // `afterAll` её удаляет; а то, что оставил убитый прогон (`afterAll` не дошёл), снимает
    // уборка в начале следующего: задача пробы, чей процесс мёртв или которой больше часа.
    beforeAll(async () => {
      await sweepStaleProbeTasks();
    });
    afterAll(async () => {
      await runTool(system32('schtasks.exe'), ['/Delete', '/TN', name, '/F']);
    });

    it('P57 Windows: task installed for real (disabled), read back by schtasks, then removed', async () => {
      const cwd = mkdtempSync(join(root, 'task-'));
      const outcome = await installKeepalive(
        {
          name,
          description: 'P57 probe — disabled, removed by the test',
          command: system32('cmd.exe'),
          args: ['/c', 'exit', '0'],
          cwd,
          enabled: false,
        },
        { scratchDir: cwd },
      );
      expect(outcome).toEqual({ ok: true, path: `\\${name}`, notes: [] });
      const back = await runTool(system32('schtasks.exe'), ['/Query', '/TN', name, '/XML']);
      if (!back.ok) throw new Error(back.reason);
      expect(back.stdout).toContain('<Command>');
      // `schtasks /Query /XML` печатает в кодовой странице консоли (ü → u): каталог с
      // не-латиницей читается обратно через Планировщик в UTF-8.
      const stored = execFileSync(
        system32('WindowsPowerShell\\v1.0\\powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ScheduledTask -TaskName '${name}').Actions[0].WorkingDirectory`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      expect(stored).toBe(cwd);
      expect(back.stdout).toContain('<Enabled>false</Enabled>');
      expect(await validateKeepalive(`\\${name}`, 'win32')).toEqual({ value: true });
      expect(existsSync(join(cwd, `${name}.task.xml`))).toBe(false);
      expect((await removeKeepalive(name)).ok).toBe(true);
      const gone = await runTool(system32('schtasks.exe'), ['/Query', '/TN', name]);
      expect(gone.ok).toBe(false);
    }, 60_000);

    it('P57 Windows (F-123): a probe task left by a killed run (its pid is dead) is swept; a live run’s task and foreign tasks are kept', async () => {
      // Мёртвый pid — свой, только что завершившийся процесс.
      const dead = spawnSync(system32('cmd.exe'), ['/c', 'exit', '0'], { windowsHide: true }).pid;
      expect(dead).toBeGreaterThan(0);
      const stale = `${PROBE_PREFIX}${dead}-${Date.now()}`;
      const live = `${PROBE_PREFIX}${process.pid}-${Date.now() + 1}`;
      const cwd = mkdtempSync(join(root, 'sweep-'));
      try {
        for (const task of [stale, live]) {
          const outcome = await installKeepalive(
            {
              name: task,
              description: 'P57 sweep probe — disabled, removed by the test',
              command: system32('cmd.exe'),
              args: ['/c', 'exit', '0'],
              cwd,
              enabled: false,
            },
            { scratchDir: cwd },
          );
          expect(outcome.ok, task).toBe(true);
        }
        const swept = await sweepStaleProbeTasks();
        expect(swept).toContain(stale);
        expect(swept).not.toContain(live);
        expect(swept.every((task) => task.startsWith(PROBE_PREFIX))).toBe(true);
        expect((await runTool(system32('schtasks.exe'), ['/Query', '/TN', stale])).ok).toBe(false);
        expect((await runTool(system32('schtasks.exe'), ['/Query', '/TN', live])).ok).toBe(true);
      } finally {
        for (const task of [stale, live])
          await runTool(system32('schtasks.exe'), ['/Delete', '/TN', task, '/F']);
      }
    }, 60_000);
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
