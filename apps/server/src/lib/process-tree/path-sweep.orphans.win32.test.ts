import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCommandTable, sweepPathProcesses } from './path-sweep.ts';

/**
 * RF-BGCD-09 на настоящей Windows: в копии группы живут четыре сироты, у всех
 * родитель уже вышел, у всех путь копии в командной строке.
 * - человека: поднят через WMI (`Win32_Process.Create` — родитель не сервер,
 *   как из окна проводника или планировщика) уже после старта сервера; прежнее
 *   правило «моложе сервера — наш» снимало его;
 * - панели: `cmd /c start /b node …` из сервера — `cmd` записан реестром и
 *   вышел, сирота родилась, пока он жил;
 * - Git Bash `node … &` с меткой группы: родитель-оболочка жила миллисекунды и
 *   в реестре её нет, свой — по метке в PEB;
 * - тот же Git Bash без метки: доказательства нет — цел.
 */

const MARK = 'AGENTDECK_TESTS_RUNS_AT_DELIVERY';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return check();
};

const pidIn = (file: string): number => Number(readFileSync(file, 'utf8'));

describe.skipIf(process.platform !== 'win32')('добор копии: сироты на настоящей Windows', () => {
  it('сирота человека цела, сироты панели сняты по реестру и по метке', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sweep-orphans-'));
    const copy = join(base, 'g0');
    mkdirSync(copy);
    const keep = join(copy, 'keep.cjs');
    writeFileSync(
      keep,
      "require('fs').writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n",
    );
    const pidFile = (name: string): string => join(copy, `${name}.pid`);
    const files = ['human', 'panel', 'bash-marked', 'bash-plain'].map(pidFile);
    try {
      // Человек: WMI создаёт процесс от имени того же пользователя, родитель — WmiPrvSE.
      const human = `cmd /d /c start "" /b "${process.execPath}" "${keep}" "${pidFile('human')}"`;
      const wmi = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; ` +
            `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:SWEEP_HUMAN; ProcessStartupInformation=$s}; ` +
            `exit $r.ReturnValue`,
        ],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, SWEEP_HUMAN: human } },
      );
      expect(wmi.status, wmi.stderr).toBe(0);

      // Панель: сервер запускает `cmd`, тот — сироту и выходит.
      const cmd = spawn(
        'cmd.exe',
        ['/d', '/s', '/c', `start "" /b "${process.execPath}" "${keep}" "${pidFile('panel')}"`],
        { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
      );
      await once(cmd, 'exit');

      // Git Bash `&`: с меткой группы и без неё.
      const bash = (name: string, env: NodeJS.ProcessEnv) => {
        const line = `"${process.execPath.replace(/\\/g, '/')}" "${keep.replace(/\\/g, '/')}" "${pidFile(name).replace(/\\/g, '/')}" &`;
        return spawn(GIT_BASH, ['-c', line], { stdio: 'ignore', windowsHide: true, env });
      };
      const marked = bash('bash-marked', { ...process.env, [MARK]: '1' });
      const plainEnv = { ...process.env };
      delete plainEnv[MARK];
      const plain = bash('bash-plain', plainEnv);
      await Promise.all([once(marked, 'exit'), once(plain, 'exit')]);

      expect(await waitFor(() => files.every((file) => existsSync(file)), 20_000)).toBe(true);
      const [humanPid, panelPid, markedPid, plainPid] = files.map(pidIn) as [
        number,
        number,
        number,
        number,
      ];

      // Предусловие: настоящие сироты — у каждой цепочка до сервера оборвана.
      const table = (await readCommandTable()) ?? [];
      const byPid = new Map(table.map((row) => [row.pid, row]));
      const reachesServer = (pid: number): boolean => {
        for (let row = byPid.get(pid), hops = 0; row && hops < 64; hops += 1) {
          if (row.pid === process.pid) return true;
          const parent = byPid.get(row.ppid);
          if (!parent || parent.created > row.created) return false;
          row = parent;
        }
        return false;
      };
      for (const pid of [humanPid, panelPid, markedPid, plainPid]) {
        expect(byPid.has(pid)).toBe(true);
        expect(reachesServer(pid)).toBe(false);
      }

      const killed = await sweepPathProcesses(copy, { mark: MARK });

      expect(killed).toContain(panelPid);
      expect(killed).toContain(markedPid);
      expect(await waitFor(() => !isAlive(panelPid) && !isAlive(markedPid), 10_000)).toBe(true);
      expect(killed).not.toContain(humanPid);
      expect(killed).not.toContain(plainPid);
      expect(isAlive(humanPid)).toBe(true);
      expect(isAlive(plainPid)).toBe(true);
    } finally {
      // Уборка: всё, что ещё живо и несёт путь копии (сироты, форк-заглушки Git Bash).
      const left = ((await readCommandTable()) ?? []).filter((row) => row.command.includes(copy));
      for (const row of left) {
        try {
          process.kill(row.pid);
        } catch {
          // Уже вышел.
        }
      }
      for (const file of files.filter((item) => existsSync(item))) {
        try {
          process.kill(pidIn(file));
        } catch {
          // Уже вышел.
        }
      }
      await waitFor(() => files.every((file) => !existsSync(file) || !isAlive(pidIn(file))), 5_000);
      rmSync(base, { recursive: true, force: true });
    }
  }, 90_000);
});
