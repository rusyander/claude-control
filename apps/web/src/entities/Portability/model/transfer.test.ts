import { describe, it, expect } from 'vitest';
import { emitOutcomes, type EmitEntry, type EmitOutcome } from '@agentdeck/contracts/portable-emit';
import type { TransferFilePlan, TransferPlan } from '@agentdeck/contracts/portable-transfer';
import { OUTCOME_TONE, summarizeOutcomes, summarizePlan } from './transfer.ts';

/**
 * Сводка переноса на экране (П2.3).
 *
 * Проверяется не арифметика, а два способа соврать человеку: потерять записи,
 * которые у цели УЖЕ есть (они не создают файлов и потому выпадают из наивного
 * счёта), и показать число, за которым не стоит ни одной строки плана.
 */

function entry(outcome: EmitOutcome, itemId: string = outcome): EmitEntry {
  return {
    itemId,
    kind: 'skill',
    intent: 'скилл делает то-то',
    outcome,
    verdict: { level: 'native', reason: 'target_mechanism', condition: null, fallback: 'native' },
    file: outcome === 'written' ? '/дом/цель/skills/имя/SKILL.md' : null,
  };
}

function file(overrides: Partial<TransferFilePlan> = {}): TransferFilePlan {
  return {
    filePath: '/дом/цель/GEMINI.md',
    kinds: ['instructions'],
    itemIds: ['instructions'],
    exists: true,
    unchanged: false,
    lines: [],
    added: 3,
    removed: 1,
    truncated: false,
    ...overrides,
  };
}

function plan(overrides: Partial<TransferPlan> = {}): TransferPlan {
  return {
    source: 'claude',
    target: 'gemini',
    scope: 'global',
    root: '/дом/цель',
    fingerprint: 'о'.repeat(64),
    computedAt: '2026-09-20T12:00:00.000Z',
    entries: [],
    files: [],
    report: {
      source: 'claude',
      target: 'gemini',
      scope: 'global',
      computedAt: '2026-09-20T12:00:00.000Z',
      canonVersion: 1,
      rows: [],
      summary: { native: 0, emulated: 0, wired: 0, text: 0, impossible: 0 },
      onlyThroughPanel: 0,
    },
    ...overrides,
  };
}

describe('сводка исходов', () => {
  it('называет каждый исход канона, включая те, которых в плане нет', () => {
    const counts = summarizeOutcomes([entry('written'), entry('written', 'второй')]);

    // Ноль — это ответ: исход без строки обязан быть показан нулём, а не
    // отсутствовать. Пропавшая строка читается как «такого не бывает».
    expect(Object.keys(counts).sort()).toEqual([...emitOutcomes].sort());
    expect(counts.written).toBe(2);
    expect(counts.not_transferable).toBe(0);
  });

  it('у каждого исхода канона есть свой цвет', () => {
    for (const outcome of emitOutcomes) expect(OUTCOME_TONE[outcome]).toBeTruthy();
  });
});

describe('сводка плана', () => {
  it('«доедет» включает записи, которые у цели уже лежат', () => {
    const summary = summarizePlan(
      plan({ entries: [entry('written'), entry('already_available'), entry('not_transferable')] }),
    );

    // Главная ловушка счёта: `already_available` не создаёт ни одного файла, и
    // счёт «по записанному» объявил бы непереехавшим то, что у цели уже есть.
    expect(summary.lands).toBe(2);
    expect(summary.runtimeOnly).toBe(0);
  });

  it('записи рантайма считаются отдельно от доехавших', () => {
    const summary = summarizePlan(plan({ entries: [entry('runtime_only'), entry('written')] }));

    expect(summary.runtimeOnly).toBe(1);
    expect(summary.lands).toBe(1);
  });

  it('файлы: создаваемые и неизменные названы отдельно, строки сложены', () => {
    const summary = summarizePlan(
      plan({
        files: [
          file(),
          file({ filePath: '/дом/цель/settings.json', exists: false, added: 10, removed: 0 }),
          file({ filePath: '/дом/цель/старое.md', unchanged: true, added: 0, removed: 0 }),
        ],
      }),
    );

    expect(summary.files).toBe(3);
    expect(summary.created).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.added).toBe(13);
    expect(summary.removed).toBe(1);
  });

  it('пустой план — нули, а не пустота', () => {
    const summary = summarizePlan(plan());

    expect(summary).toEqual({
      files: 0,
      created: 0,
      unchanged: 0,
      added: 0,
      removed: 0,
      lands: 0,
      runtimeOnly: 0,
    });
  });
});
