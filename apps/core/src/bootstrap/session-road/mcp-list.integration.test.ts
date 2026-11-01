import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { liveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { fixturePath, installReplay } from '../../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { roadStart, roadTask } from '../__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from '../boot.ts';
import { sessionMcpList, strictServers } from './mcp-list.ts';

/**
 * Строгий список MCP на настоящей дороге (P73, F-11): `prepare` загрузки кладёт в оверлей CLI
 * только серверы списка вида шага, инструменты ядра не своего вида — в запреты MCP сеанса, и тот
 * же набор видит судья права; отпечаток списка — `mcpHash` ключа замера базы. CLI подставной,
 * но до запуска дело не доходит: проверяется то, что дорога собрала.
 */

const cores: BootedCore[] = [];
afterAll(async () => {
  for (const core of cores) await core.stop();
});

describe('session road MCP list', () => {
  it('P73 the overlay and the permit judge get the step kind deny list; the list hash keys the base', async () => {
    const core = await bootCore({
      home: join(tempDir('road-mcp-'), 'core'),
      build: 'road-test',
      loop: false,
      loginPath: async () => ({ path: process.env.PATH ?? '', source: 'known-dirs' }),
    });
    cores.push(core);
    const live = liveRoot('road-mcp-');
    const bin = join(live.root, 'bin');
    mkdirSync(bin, { recursive: true });
    installReplay(bin, claudeRunFacts.binary.command);
    const task = await roadTask(core, claudeRunFacts.id);
    const prepareAs = async (stepKind: string) => {
      const start = roadStart({
        live,
        bin,
        task,
        adapterId: claudeRunFacts.id,
        fixture: fixturePath(claudeRunFacts.id, 'permit'),
        dump: join(live.root, `dump-${newId()}.json`),
      });
      const got = await core.road.prepare({ ...start, stepKind });
      if (!got.ok) throw new Error(got.reason);
      return got.prepared;
    };

    const work = await prepareAs('work');
    expect(Object.keys(work.spec.mcpServers ?? {}).sort()).toEqual([
      'agentdeck',
      'agentdeck-permit',
    ]);
    // Работа меняет код: `check` у неё есть, `unit_diff` (судить сделанное) — нет.
    expect(work.spec.deny.mcpTools).toContain('mcp__agentdeck__unit_diff');
    expect(work.spec.deny.mcpTools).not.toContain('mcp__agentdeck__check');
    expect(work.context.deny.mcpTools).toContain('mcp__agentdeck__unit_diff');

    const report = await prepareAs('report');
    expect(report.spec.deny.mcpTools).toEqual(
      expect.arrayContaining(['mcp__agentdeck__check', 'mcp__agentdeck__unit_diff']),
    );
    expect(report.context.deny.mcpTools).toContain('mcp__agentdeck__check');
    // Судья права и после прикрепления — те же запреты, что у оверлея (F-11).
    const reportStart = report.start;
    expect(core.road.contextFor(reportStart).deny.mcpTools).toContain('mcp__agentdeck__check');

    expect(work.mcpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.mcpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(work.mcpHash).not.toBe(report.mcpHash);
  }, 60_000);

  it('the strict list keeps only listed servers; a step kind without a model session has no list', () => {
    const list = sessionMcpList('work', 'stub-1');
    const all = { agentdeck: 1, 'agentdeck-permit': 2, 'human-db': 3 };
    // Сервер человека без предложения в список не попал — в оверлей CLI он не уходит.
    expect(Object.keys(strictServers(all, list)).sort()).toEqual(['agentdeck', 'agentdeck-permit']);
    expect(sessionMcpList('check', 'stub-1')).toBeNull();
    expect(strictServers(all, null)).toBe(all);
  });
});
