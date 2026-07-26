import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { killChildTree, killPidTree, type KillableChild } from './process-tree.ts';

/**
 * Снятие процесса вместе с потомками.
 *
 * Ради чего модуль и появился: `child.kill()` при запуске через оболочку убивает
 * оболочку, а не CLI. Это повторялось в четырёх местах (чат, ассистент, ресурсы,
 * проба хука), поэтому проверяем сам общий примитив.
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
    const child: KillableChild = { pid: undefined, kill: vi.fn(() => true) };
    killChildTree(child);
    expect(child.kill).toHaveBeenCalled();
  });

  it('исключение из kill не выходит наружу: остановка не должна ронять ответ', () => {
    const child: KillableChild = {
      pid: undefined,
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
