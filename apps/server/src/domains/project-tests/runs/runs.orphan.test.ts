import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun } from '../../chat/ChatRunner/ChatRunner.ts';
import { isPidAlive, RunLedger } from '../../chat/run-ledger/run-ledger.ts';
import {
  PROJECT_TEST_PROCESS_LEDGER,
  ProjectTestRunRegistry,
  reapProjectTestOrphans,
} from './runs.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Сирота агентского прогона тестов (F-105). `node --watch` на Windows убивает
 * панель без обработчиков, а CLI прогона живёт дальше: висит на мёртвом
 * приёмнике прав до суток вместе с браузером под тестом, а история пишет
 * «агент остановился вместе с ней». Доказательство — НАСТОЯЩИЙ процесс node под
 * видом CLI прогона: жив после «перезапуска» и мёртв после уборки на старте.
 */
describe('project-tests/runs: процесс прогона после перезапуска панели', () => {
  let root = '';
  let appData = '';
  let child: ChildProcess | undefined;
  const now = '2026-09-28T10:00:00.000Z';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-orphan-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-tests-orphan-data-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, now);
  });

  afterEach(() => {
    if (child?.pid && isPidAlive(child.pid)) child.kill();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const waitDead = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!isPidAlive(pid)) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };

  /** Прогон, чей «CLI» — живой процесс node, а `start` не кончается, как у идущего агента. */
  const startRun = (registry: ProjectTestRunRegistry): number => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    vi.spyOn(ChatRun.prototype, 'pid', 'get').mockReturnValue(pid);
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(() => new Promise(() => {}));
    registry.start({ projectPath: root, mode: 'run', groupId: 'gui' }, now, undefined, undefined, {
      appData,
    });
    return pid;
  };

  it('старт панели снимает дерево CLI прогона, пережившего прошлый процесс', async () => {
    const pid = startRun(new ProjectTestRunRegistry());
    await vi.waitFor(() =>
      expect(new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).read()).toEqual([
        expect.objectContaining({ pid, cwd: root }),
      ]),
    );

    // Реестр «умер» вместе с панелью, процесс жив; новый старт убирает его.
    expect(isPidAlive(pid)).toBe(true);
    expect(reapProjectTestOrphans(appData)).toBe(1);
    expect(await waitDead(pid)).toBe(true);
    expect(new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).read()).toEqual([]);
  });

  it('остановленный прогон снимает свою запись: убивать на старте нечего', async () => {
    const registry = new ProjectTestRunRegistry();
    const pid = startRun(registry);
    await vi.waitFor(() =>
      expect(new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).read()).toHaveLength(1),
    );
    registry.stop(root);

    expect(new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).read()).toEqual([]);
    const killed: number[] = [];
    expect(reapProjectTestOrphans(appData, { kill: (id) => killed.push(id) })).toBe(0);
    expect(killed).toEqual([]);
    expect(isPidAlive(pid)).toBe(true);
  });
});
