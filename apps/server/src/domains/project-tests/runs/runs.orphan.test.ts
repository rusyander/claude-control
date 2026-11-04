import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPidAlive, RunLedger } from '../../chat/run-ledger/run-ledger.ts';
import { fakeCorePort, waitFor } from '../agent/__fixtures__/fake-core-port.ts';
import {
  PROJECT_TEST_PROCESS_LEDGER,
  ProjectTestRunRegistry,
  reapProjectTestOrphans,
} from './runs.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Процессы агентского прогона тестов (F-105, этап 10). До этапа 10 CLI прогона был потомком панели
 * и переживал её падение — журнал процессов и уборка на старте снимали его. Теперь CLI — потомок
 * хоста сеанса ядра, его жизнь ведёт ядро, и панель в журнал не пишет; но запись, оставленная
 * панелью прежней версии, на старте всё ещё снимается. Доказательство — НАСТОЯЩИЙ процесс node.
 */
describe('project-tests/runs: процессы прогона и перезапуск панели', () => {
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

  it('старт панели снимает дерево CLI, записанное панелью прежней версии', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).upsert({
      key: 'tests-old',
      cwd: root,
      pid,
      startedAt: Date.now(),
    });
    expect(isPidAlive(pid)).toBe(true);
    expect(reapProjectTestOrphans(appData)).toBe(1);
    expect(await waitDead(pid)).toBe(true);
    expect(new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).read()).toEqual([]);
  });

  it('прогон через ядро в журнал панели не пишет: процесс CLI ведёт ядро', async () => {
    const core = fakeCorePort({ hold: true });
    const registry = new ProjectTestRunRegistry();
    registry.setCorePort(core.port);
    registry.start({ projectPath: root, mode: 'run', groupId: 'gui' }, now, undefined, undefined, {
      appData,
    });
    await waitFor(() => core.calls.some((c) => c.kind === 'launch'));
    expect(new RunLedger(appData, PROJECT_TEST_PROCESS_LEDGER).read()).toEqual([]);
    registry.stop(root);
    await waitFor(() => core.calls.some((c) => c.kind === 'cancel'));
    const killed: number[] = [];
    expect(reapProjectTestOrphans(appData, { kill: (id) => killed.push(id) })).toBe(0);
    expect(killed).toEqual([]);
  });
});
