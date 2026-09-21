import { describe, expect, it } from 'vitest';
import type { AgentEnvironment, PermissionItem } from '@agentdeck/contracts/portable-env';
import { buildFidelityReport } from './fidelity-report.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';

/**
 * ВЫКЛЮЧЕННЫЙ БРОКЕР — ЭТО УРОВЕНЬ «Т» В ОТЧЁТЕ, А НЕ ТИШИНА (П4.2, критерий 3).
 *
 * Приговор о том, что правило принуждается только проводом, матрица выносила и
 * раньше (`fidelity.test.ts`). Здесь проверяется то, чего приговор сам по себе не
 * обещает: что запасной уровень и условие ДОЕЗЖАЮТ ДО СТРОКИ ОТЧЁТА — до того
 * самого места, куда смотрит человек, решая, переносить ли права. Строка,
 * назвавшая «П» и умолчавшая про «Т», обещала бы принуждение, которого без
 * контура нет.
 */

const source = {
  provider: 'claude',
  scope: 'global' as const,
  origin: 'file' as const,
  file: '/home/u/.claude/settings.json',
  plugin: null,
};

/** Правило с уточнением аргумента: записать его у цели со скалярным режимом некуда. */
const rule: PermissionItem = {
  id: 'permission:deny-Bash(rm -rf:*)',
  kind: 'permission',
  source,
  intent: 'deny: Bash(rm -rf:*)',
  trigger: { on: 'always' },
  blocking: 'blocks',
  needs: { resolution: 'facts', facts: ['tool_name', 'tool_input'], evidence: 'declared' },
  sideEffects: [],
  rule: 'Bash(rm -rf:*)',
  decision: 'deny',
  enabled: true,
  order: 0,
  raw: 'Bash(rm -rf:*)',
};

const env: AgentEnvironment = {
  canonVersion: 2,
  provider: 'claude',
  scope: 'global',
  root: '/home/u/.claude',
  capturedAt: '2026-09-21T00:00:00.000Z',
  items: [rule],
  skipped: [],
  sectionStates: [],
};

const providerById = (id: string) => {
  const found = CATALOG_PROVIDERS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`в каталоге нет цели ${id}`);
  return found;
};

describe('отчёт называет запас, а не молчит о нём', () => {
  it('правило, которое принуждает только брокер, показано как «П» с запасом «Т»', () => {
    const report = buildFidelityReport(env, providerById('codex'), '2026-09-21T00:00:00.000Z');
    const row = report.rows.find((candidate) => candidate.itemId === rule.id);

    expect(row).toBeDefined();
    expect(row?.level).toBe('wired');
    // Условие и запас — это и есть «а если провода нет»: без них строка обещает
    // принуждение, которого у выключенного брокера нет.
    expect(row?.condition).not.toBeNull();
    expect(row?.fallback).toBe('text');
  });

  it('у цели без провода запас становится самим уровнем — и это тоже сказано', () => {
    const report = buildFidelityReport(env, providerById('goose'), '2026-09-21T00:00:00.000Z');
    const row = report.rows.find((candidate) => candidate.itemId === rule.id);

    expect(row?.level).toBe('text');
    expect(row?.fallback).toBe('text');
  });

  it('строка есть у КАЖДОЙ цели каталога: потерянное молчанием читается как «доедет»', () => {
    for (const target of CATALOG_PROVIDERS) {
      const report = buildFidelityReport(env, target, '2026-09-21T00:00:00.000Z');
      expect(
        report.rows.map((row) => row.itemId),
        target.id,
      ).toContain(rule.id);
    }
  });
});
