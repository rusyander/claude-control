import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  killChildTree,
  killPidTree,
  wasStoppedOnPurpose,
  type KillableChild,
} from './process-tree.ts';
import { filetimeFromMs } from './kill-tree.mjs';

/**
 * Снятие процесса вместе с потомками.
 *
 * Ради чего модуль и появился: `child.kill()` при запуске через оболочку убивает
 * оболочку, а не CLI. Это повторялось в четырёх местах (чат, ассистент, ресурсы,
 * проба хука), поэтому проверяем сам общий примитив. Обход дерева на подменённой
 * таблице — в `kill-tree.test.ts`; здесь обёртка и настоящие процессы.
 */
describe('killChildTree', () => {
  const platform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value });
  };

  it('зовёт kill самого процесса — иначе оболочка осталась бы жить', () => {
    const child: KillableChild = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    killChildTree(child);
    expect(child.kill).toHaveBeenCalled();
  });

  it('исключение из kill не выходит наружу: остановка не должна ронять ответ', () => {
    const child: KillableChild = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error('ESRCH');
      },
    };
    expect(() => killChildTree(child)).not.toThrow();
  });

  it('несуществующий PID не бросает ни на одной платформе', () => {
    setPlatform('linux');
    expect(() => killPidTree(2_147_483_600)).not.toThrow();
    expect(() => killPidTree(2_147_483_600, { group: true })).not.toThrow();
  });

  it('каждый снятый номер помечен «снят нарочно» — не только корень', () => {
    const at = (s: number): bigint => filetimeFromMs(Date.UTC(2026, 8, 27) + s * 1000);
    const table = [
      { pid: 910, ppid: 1, created: at(1) },
      { pid: 911, ppid: 910, created: at(2) },
    ];
    const killed = killPidTree(
      910,
      {},
      { platform: 'win32', readTable: () => table, kill: vi.fn() },
    );
    expect(killed).toEqual([911, 910]);
    expect(wasStoppedOnPurpose(910)).toBe(true);
    expect(wasStoppedOnPurpose(911)).toBe(true);
  });

  // F-308: этой обёрткой снимает серверы проекта (`group` на POSIX).
  it('вышедший лидер своей группы — группа снимается по номеру группы', () => {
    const kill = vi.fn();
    const child: KillableChild = {
      pid: 920,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    killChildTree(
      child,
      { group: true },
      { platform: 'linux', readGroups: () => [{ pid: 921, pgid: 920 }], kill },
    );
    expect(kill).toHaveBeenCalledWith(-920, 'SIGTERM');
    expect(child.kill).toHaveBeenCalled();
  });

  it('настоящий процесс действительно умирает', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    await new Promise((ready) => child.once('spawn', ready));

    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    killChildTree(child);
    await exited;

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 15_000);
});

/**
 * Настоящие процессы Windows: снимок системы, обход и сигналы — без подмен.
 * Номера, которые снимает уборка в `finally`, — только записанные самим тестом.
 */
describe.runIf(process.platform === 'win32')('killChildTree на настоящих процессах Windows', () => {
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

  it('node → cmd → node → node снимается целиком, посторонний отвязанный процесс жив', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kill-tree-real-'));
    const recorded: { pid: number; at: number }[] = [];
    try {
      // Посторонний: запущен ДО дерева, отвязан, к дереву отношения не имеет.
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      bystander.unref();
      recorded.push({ pid: bystander.pid!, at: Date.now() });

      const pidFile = (name: string): string => join(dir, `${name}.pid`);
      const leaf = join(dir, 'leaf.cjs');
      const mid = join(dir, 'mid.cjs');
      const top = join(dir, 'top.cjs');
      writeFileSync(
        leaf,
        `require('fs').writeFileSync(${JSON.stringify(pidFile('leaf'))}, String(process.pid));\n` +
          'setInterval(() => {}, 1000);\n',
      );
      writeFileSync(
        mid,
        `const { spawn } = require('child_process');\n` +
          `spawn(process.execPath, [${JSON.stringify(leaf)}], { stdio: 'ignore', windowsHide: true });\n` +
          `require('fs').writeFileSync(${JSON.stringify(pidFile('mid'))}, String(process.pid));\n` +
          'setInterval(() => {}, 1000);\n',
      );
      writeFileSync(
        top,
        `const { spawn } = require('child_process');\n` +
          `const shell = spawn('cmd.exe', ['/d', '/c', process.execPath, ${JSON.stringify(mid)}], { stdio: 'ignore', windowsHide: true });\n` +
          `require('fs').writeFileSync(${JSON.stringify(pidFile('cmd'))}, String(shell.pid));\n` +
          'setInterval(() => {}, 1000);\n',
      );

      const root = spawn(process.execPath, [top], { stdio: 'ignore', windowsHide: true });
      recorded.push({ pid: root.pid!, at: Date.now() });
      const names = ['cmd', 'mid', 'leaf'];
      expect(await waitFor(() => names.every((name) => existsSync(pidFile(name))), 15_000)).toBe(
        true,
      );
      const tree = [root.pid!, ...names.map((name) => Number(readFileSync(pidFile(name), 'utf8')))];
      expect(tree.every(isAlive)).toBe(true);
      recorded.push(...tree.slice(1).map((pid) => ({ pid, at: Date.now() })));

      killChildTree(root);

      expect(await waitFor(() => tree.every((pid) => !isAlive(pid)), 10_000)).toBe(true);
      expect(isAlive(bystander.pid!)).toBe(true);
    } finally {
      // Уборка — тем же помощником и со временем записи: номер снятого процесса
      // мог уже достаться чужому, и голый `process.kill(pid)` снял бы его.
      for (const { pid, at } of recorded) killPidTree(pid, { spawnedAt: at });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('номер, записанный раньше создания процесса (занят чужим), не снимается', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise((ready) => child.once('spawn', ready));
      // Запись «номер наш» сделана за минуту ДО создания этого процесса.
      expect(killPidTree(child.pid!, { spawnedAt: Date.now() - 60_000 })).toEqual([]);
      await new Promise((tick) => setTimeout(tick, 300));
      expect(isAlive(child.pid!)).toBe(true);
      // Тот же процесс с верной записью — снимается (корень последним; перед ним
      // бывает его conhost.exe — у консольного процесса он настоящий ребёнок).
      expect(killPidTree(child.pid!, { spawnedAt: Date.now() }).at(-1)).toBe(child.pid);
      expect(await waitFor(() => !isAlive(child.pid!), 5_000)).toBe(true);
    } finally {
      child.kill();
    }
  }, 30_000);
});
