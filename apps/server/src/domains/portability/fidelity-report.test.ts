import { describe, expect, it } from 'vitest';
import type { AgentEnvironment, PermissionItem } from '@agentdeck/contracts/portable-env';
import { buildFidelityReport } from './fidelity-report.ts';
import { describeTarget, level } from './fidelity.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';

/**
 * ВЫКЛЮЧЕННЫЙ БРОКЕР — ЭТО УРОВЕНЬ «Т» В ОТЧЁТЕ, А НЕ ТИШИНА (П4.2, критерий 3).
 *
 * Приговор о том, что правило принуждается только проводом, матрица выносила и
 * раньше (`fidelity.test.ts`). Здесь проверяется то, чего приговор сам по себе не
 * обещает: что запасной уровень и условие ДОЕЗЖАЮТ ДО СТРОКИ ОТЧЁТА — до того
 * самого места, куда смотрит человек, решая, переносить ли права.
 *
 * СЕГОДНЯ таких строк не бывает вовсе, и это решение владельца (22.09.2026):
 * ворота на пути запроса панель не открывает (`wire/tool-gate.ts`,
 * `REQUEST_PATH_GATE_OPENED`), поэтому включённый контур исхода не меняет, и
 * строка держится на запасном уровне со своей причиной. Обе половины проверяются
 * ниже: что экран не обещает контур при закрытых воротах и что при открытых
 * обещание возвращается ровно тем же кодом.
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
  it('пока ворота закрыты, строка не обещает контур — «Т» со своей причиной', () => {
    const report = buildFidelityReport(env, providerById('codex'), '2026-09-21T00:00:00.000Z');
    const row = report.rows.find((candidate) => candidate.itemId === rule.id);

    expect(row).toBeDefined();
    expect(row?.level).toBe('text');
    // Условия НЕТ: «включите контур» здесь было бы советом, который ничего не
    // меняет, — ворота всё равно пусты.
    expect(row?.condition).toBeNull();
    // И причина осталась своей: правило не выразить механизмом цели. Подменить
    // её на «панель не дотянула» значило бы послать человека чинить не то.
    expect(row?.reason).toBe('no_mechanism');
    expect(report.onlyThroughPanel).toBe(0);
  });

  it('ворота открыты — обещание контура возвращается тем же кодом', () => {
    // Вторая половина того же решения: матрица не «разучилась» выносить «П», она
    // не выносит его, пока принуждать некому. Профиль здесь собирается описанием
    // цели, где открыта ровно эта половина механизма.
    const opened = { ...describeTarget(providerById('codex')), wireOpened: true };
    const verdict = level(rule, opened);

    expect(verdict.level).toBe('wired');
    expect(verdict.condition).toBe('enable_contour');
    expect(verdict.fallback).toBe('text');
    expect(verdict.reason).toBe('no_mechanism');
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
