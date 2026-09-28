import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPidAlive, RunLedger } from '../chat/run-ledger.ts';
import { E2E_RUN_PROCESS_LEDGER, E2eRunRegistry } from './e2e-run.ts';
import { reapProjectTestOrphans } from './runs.ts';

/**
 * F-105 (сосед): «Прогнать автотесты» запускает раннер через оболочку, и жёсткое
 * убийство панели (`node --watch` на Windows, `taskkill /F` без `/T`) оставляло
 * его жить: Playwright с браузерами сиротой, а сирота дописывал отчёт по тому же
 * пути, что читает следующий прогон. Доказательство — НАСТОЯЩИЙ раннер своей
 * командой проекта: запись в журнале, пока идёт, и мёртв после уборки на старте.
 */
describe('project-tests/e2e-run: раннер после перезапуска панели', () => {
  let root = '';
  let appData = '';
  let registry: E2eRunRegistry | undefined;
  const pids: number[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-e2e-orphan-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-e2e-orphan-data-'));
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    // Раннер, который не кончается сам, как идущий набор Playwright.
    writeFileSync(
      join(root, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ command: 'node -e "setInterval(() => {}, 1000)"' }),
    );
  });

  afterEach(() => {
    registry?.stopAll();
    for (const pid of pids) if (isPidAlive(pid)) process.kill(pid);
    pids.length = 0;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const ledger = () => new RunLedger(appData, E2E_RUN_PROCESS_LEDGER);

  const waitDead = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!isPidAlive(pid)) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };

  it('старт панели снимает дерево раннера, пережившего прошлый процесс', async () => {
    registry = new E2eRunRegistry();
    registry.start({ root, appData });
    // На Windows журнал сперва держит оболочку, потом — найденный под ней node.
    await vi.waitFor(
      () => {
        const [entry] = ledger().read();
        expect(entry).toMatchObject({ cwd: root });
        expect(entry?.pid).toBeGreaterThan(0);
      },
      { timeout: 15_000 },
    );
    await new Promise((done) => setTimeout(done, 2_000));
    const pid = ledger().read()[0]!.pid!;
    pids.push(pid);
    expect(isPidAlive(pid)).toBe(true);

    // Реестр «умер» вместе с панелью — процесс жив; новый старт его убирает.
    expect(reapProjectTestOrphans(appData)).toBe(1);
    expect(await waitDead(pid)).toBe(true);
    expect(ledger().read()).toEqual([]);
  }, 30_000);

  it('остановленный прогон снимает свою запись: убивать на старте нечего', async () => {
    registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(ledger().read()).toHaveLength(1), { timeout: 15_000 });
    registry.stop(root);
    await vi.waitFor(() => expect(registry?.isRunning(root)).toBe(false), { timeout: 15_000 });

    expect(ledger().read()).toEqual([]);
    const killed: number[] = [];
    expect(reapProjectTestOrphans(appData, { kill: (id) => killed.push(id) })).toBe(0);
    expect(killed).toEqual([]);
  }, 30_000);
});
