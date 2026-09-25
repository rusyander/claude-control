import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { RELAY_SCRIPT } from './live-transport.ts';

const LAUNCHER = join(import.meta.dirname, 'live-relay-launch.mjs');
const FAKE_CLI = join(import.meta.dirname, '__fixtures__', 'fake-live-cli.mjs');

/**
 * Посредник и задание (job object) запустившего сервер (итоговая проверка
 * 25.09): задание с «убить всех при закрытии» без разрешённого выхода уносило
 * посредника с его CLI, хотя посредник ради того и заведён, чтобы пережить
 * сервер. Путь настоящий: пусковой процесс в задании с KILL_ON_JOB_CLOSE,
 * задание закрывается вместе с его хозяином, посредник проверяется живым и
 * отвечающим по каналу. Контроль — тот же прогон без обхода через WMI: там
 * посредник обязан умереть, иначе проверка ничего не доказывает.
 */
describe.skipIf(process.platform !== 'win32')('посредник выходит из задания запустившего', () => {
  let root: string;
  let relayPid = 0;

  afterEach(() => {
    if (relayPid > 0) spawnSync('taskkill', ['/PID', String(relayPid), '/T', '/F']);
    relayPid = 0;
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** Пусковой процесс в задании, которое закрывается с концом PowerShell. */
  function launchInKillOnCloseJob(breakaway: boolean): { pid: number; pipe: string } {
    root = mkdtempSync(join(tmpdir(), 'cc-relay-job-'));
    const pipe = `\\\\.\\pipe\\cc-relay-job-${process.pid}-${breakaway ? 1 : 0}`;
    const spec = join(root, 'spec.json');
    writeFileSync(
      spec,
      JSON.stringify({
        command: process.execPath,
        args: [FAKE_CLI],
        cwd: root,
        env: process.env,
        shell: false,
        pipe,
      }),
    );
    const pidFile = join(root, 'pid.txt');
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 байта на x64): LimitFlags по
    // смещению 16 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000), без BREAKAWAY_OK.
    const script = `
Add-Type -Namespace J -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr CreateJobObject(System.IntPtr a, string n);
[DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(System.IntPtr j, int c, byte[] i, int l);
[DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(System.IntPtr j, System.IntPtr p);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetCurrentProcess();
'@
$job = [J.K]::CreateJobObject([System.IntPtr]::Zero, $null)
$info = New-Object byte[] 144
[BitConverter]::GetBytes([uint32]0x2000).CopyTo($info, 16)
if (-not [J.K]::SetInformationJobObject($job, 9, $info, 144)) { throw 'job limits' }
if (-not [J.K]::AssignProcessToJobObject($job, [J.K]::GetCurrentProcess())) { throw 'job assign' }
$out = & '${process.execPath}' '${LAUNCHER}' '${RELAY_SCRIPT}' '${spec}'
Set-Content -Path '${pidFile}' -Value $out
`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: { ...process.env, AGENTDECK_RELAY_BREAKAWAY: breakaway ? '1' : '0' },
      },
    );
    expect(result.stderr).toBe('');
    const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : 0);
    expect(pid).toBeGreaterThan(0);
    return { pid, pipe };
  }

  async function settle(): Promise<void> {
    await new Promise((done) => setTimeout(done, 1_000));
  }

  it('через WMI посредник переживает закрытие задания и отвечает по каналу', async () => {
    const { pid, pipe } = launchInKillOnCloseJob(true);
    relayPid = pid;
    await settle();

    expect(alive(pid)).toBe(true);
    const first = await new Promise<string>((resolve, reject) => {
      const socket = connect(pipe);
      socket.once('error', reject);
      createInterface({ input: socket }).once('line', (line) => {
        socket.destroy();
        resolve(line);
      });
    });
    expect(first).toContain('relay_synced');
  }, 60_000);

  it('контроль: без обхода посредник умирает вместе с заданием', async () => {
    const { pid } = launchInKillOnCloseJob(false);
    relayPid = pid;
    await settle();

    expect(alive(pid)).toBe(false);
  }, 60_000);
});
