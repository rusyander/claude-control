import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closedSleepers, settle } from './__fixtures__/closed-sleeper.ts';
import { identityOfPid } from './process-identity.ts';
import { stopTree } from './tree-stop.ts';

/**
 * F-55 на настоящем /proc: свой процесс, чьё окружение закрыто (не-dumpable — ssh-agent, gpg-agent,
 * песочница браузера; здесь — запуск бинарника без права чтения), мог бы нести метку дерева. Но
 * метку раздают только потомки корня, а окружение задаётся при запуске: процесс СТАРШЕ корня её
 * не несёт и остановку «не доказанной» не делает. Младший закрытый — по-прежнему сомнение.
 * `.alone`: закрытый процесс виден любому соседнему поиску — файл идёт отдельным проходом.
 */

const isLinux = process.platform === 'linux';
const MARK = 'AGENTDECK_TREE';
const sleepers = closedSleepers('tree-unread-');
const roots: ChildProcess[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) if (root.exitCode === null) root.kill('SIGKILL');
  sleepers.killAll();
});
afterAll(() => sleepers.dispose());

async function markedRoot(value: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    env: { ...process.env, [MARK]: value },
  });
  roots.push(child);
  const id = await identityOfPid(child.pid ?? 0);
  if (!('value' in id)) throw new Error(`setup: no identity for root ${child.pid}`);
  return id.value;
}

describe.runIf(isLinux)('F-55 Linux tree stop beside an own process with a closed environ', () => {
  it('a closed own process born before the root does not make the stop unproven', async () => {
    const closed = await sleepers.start();
    // Старше корня с запасом точности старта Linux (секунда).
    await settle(1_300);
    const value = `older-${process.pid}-${Date.now()}`;
    const root = await markedRoot(value);
    const report = await stopTree(root, { group: true, marker: { name: MARK, value } });
    expect(report.unknown).toBeUndefined();
    expect(report.residual).toEqual([]);
    expect(report.targeted.map((id) => id.pid)).toContain(root.pid);
    expect(report.targeted.map((id) => id.pid)).not.toContain(closed);
  }, 30_000);

  it('a closed own process born after the root (could carry the marker) still makes it unproven', async () => {
    const value = `younger-${process.pid}-${Date.now()}`;
    const root = await markedRoot(value);
    await settle(1_300);
    const closed = await sleepers.start({ [MARK]: value });
    const report = await stopTree(root, { group: true, marker: { name: MARK, value } });
    expect(report.unknown).toMatch(new RegExp(`unreadable environ \\(pid [^)]*\\b${closed}\\b`));
  }, 30_000);
});
