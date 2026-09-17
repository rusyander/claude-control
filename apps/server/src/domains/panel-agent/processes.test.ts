import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPidAlive, RunLedger } from '../chat/run-ledger.ts';
import {
  PANEL_AGENT_PROCESS_LEDGER,
  PanelAgentProcesses,
  reapPanelAgentOrphans,
} from './processes.ts';

/**
 * Сирота хода агента после перезапуска панели (m2 ревью): доказательство —
 * НАСТОЯЩИЙ процесс node, живой до старта и мёртвый после `reapPanelAgentOrphans`,
 * с настоящими пробами «жив ли» и «похож ли на CLI» и настоящим снятием дерева.
 */
describe('процессы агента панели', () => {
  let appData: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-procs-'));
  });
  afterEach(() => {
    if (child?.pid && isPidAlive(child.pid)) child.kill();
    rmSync(appData, { recursive: true, force: true });
  });

  const waitDead = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!isPidAlive(pid)) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };

  it('старт панели снимает живой процесс из журнала и чистит журнал', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(isPidAlive(pid)).toBe(true);

    // Как оставил бы прошлый процесс панели: запись есть, `exited` не случился.
    const processes = new PanelAgentProcesses(() => appData, { list: async () => [] });
    processes.started('conv-orphan', pid, appData);
    // Мёртвая запись рядом — не повод что-то убивать, но из журнала уходит.
    new RunLedger(appData, PANEL_AGENT_PROCESS_LEDGER).upsert({
      key: 'conv-dead',
      pid: 2_147_483_000,
      cwd: appData,
      startedAt: Date.now(),
    });

    expect(reapPanelAgentOrphans(appData)).toBe(1);
    expect(await waitDead(pid)).toBe(true);
    expect(new RunLedger(appData, PANEL_AGENT_PROCESS_LEDGER).read()).toEqual([]);
  });

  it('обычный конец хода снимает запись: убивать на старте нечего', () => {
    const processes = new PanelAgentProcesses(() => appData, { list: async () => [] });
    processes.started('conv-1', process.pid, appData);
    const file = join(appData, PANEL_AGENT_PROCESS_LEDGER);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
      expect.objectContaining({ key: 'conv-1', pid: process.pid }),
    ]);
    processes.exited('conv-1');
    const killed: number[] = [];
    expect(reapPanelAgentOrphans(appData, { kill: (pid) => killed.push(pid) })).toBe(0);
    expect(killed).toEqual([]);
  });
});
