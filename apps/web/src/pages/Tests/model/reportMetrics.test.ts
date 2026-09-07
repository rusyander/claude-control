import { describe, it, expect } from 'vitest';
import type { ProjectTestReport, ProjectTestRunRecord } from '@agentdeck/contracts';
import { automationTotal, formatRunDuration, statusTotals, trendBars } from './reportMetrics';

const report = (part: Partial<ProjectTestReport>): ProjectTestReport => ({
  areas: [],
  automation: { manual: 0, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  releases: [],
  runs: [],
  totals: { runs: 0, tokens: 0, costUsd: 0, durationMs: 0, muted: 0 },
  ...part,
});

const run = (part: Partial<ProjectTestRunRecord> & { id: string }): ProjectTestRunRecord => ({
  mode: 'run',
  actor: 'agent',
  status: 'done',
  startedAt: '2026-09-07T10:00:00.000Z',
  results: [],
  summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
  ...part,
});

describe('statusTotals', () => {
  it('складывает зоны в общую раскладку', () => {
    const totals = statusTotals(
      report({
        areas: [
          { area: 'чат', total: 10, passed: 6, failed: 3, unknown: 1 },
          { area: 'аналитика', total: 4, passed: 4, failed: 0, unknown: 0 },
        ],
      }),
    );
    expect(totals).toEqual({ total: 14, passed: 10, failed: 3, unknown: 1 });
  });

  it('без зон даёт нули, а не пустоту — на них делят проценты', () => {
    expect(statusTotals(report({}))).toEqual({ total: 0, passed: 0, failed: 0, unknown: 0 });
  });
});

describe('automationTotal', () => {
  it('знаменатель полосы автоматизации — все три состояния', () => {
    expect(
      automationTotal(report({ automation: { manual: 3, toAutomate: 2, automated: 5 } })),
    ).toBe(10);
  });
});

describe('trendBars', () => {
  it('пустая история графика не даёт', () => {
    expect(trendBars([])).toEqual([]);
  });

  it('разворачивает историю во время: первым столбиком идёт самый старый прогон', () => {
    const bars = trendBars([run({ id: 'новый' }), run({ id: 'старый' })]);
    expect(bars.map((bar) => bar.id)).toEqual(['старый', 'новый']);
  });

  it('столбики не выходят за пределы поля 0…100 и не наезжают друг на друга', () => {
    const bars = trendBars([run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c' })]);
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(100);
    }
    expect(bars[0]!.x + bars[0]!.width).toBeLessThanOrEqual(bars[1]!.x);
  });

  it('на паре прогонов столбик не разрастается на пол-карточки', () => {
    const bars = trendBars([run({ id: 'a' }), run({ id: 'b' })]);
    // Ширина считается по минимальному числу мест, а не по числу прогонов.
    expect(bars[0]!.width).toBeLessThan(10);
    expect(bars.at(-1)!.x + bars.at(-1)!.width).toBeLessThan(20);
  });

  it('полный график занимает всю ширину', () => {
    const runs = Array.from({ length: 20 }, (_, index) => run({ id: `r${index}` }));
    const bars = trendBars(runs);
    expect(bars.at(-1)!.x + bars.at(-1)!.width).toBeGreaterThan(95);
  });

  it('высоты частей — доли прошедших и упавших от состава прогона', () => {
    const [bar] = trendBars([
      run({
        id: 'a',
        summary: { total: 4, passed: 2, failed: 1, skipped: 1, blocked: 0 },
      }),
    ]);
    expect(bar?.passed).toBe(50);
    expect(bar?.failed).toBe(25);
  });

  it('пустой прогон не рушит график делением на ноль', () => {
    const [bar] = trendBars([run({ id: 'a' })]);
    expect(bar?.passed).toBe(0);
    expect(bar?.failed).toBe(0);
  });

  it('показывается только хвост истории', () => {
    const runs = Array.from({ length: 40 }, (_, index) => run({ id: `r${index}` }));
    const bars = trendBars(runs, 10);
    expect(bars).toHaveLength(10);
    // Хвост — это последние по времени, то есть первые в приходящем списке.
    expect(bars.at(-1)?.id).toBe('r0');
  });

  it('исходный список не переворачивается на месте', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b' })];
    trendBars(runs);
    expect(runs.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('formatRunDuration', () => {
  it('идущий прогон длительности ещё не имеет', () => {
    expect(formatRunDuration('2026-09-07T10:00:00.000Z')).toBe('—');
  });

  it('секунды и минуты показываются по-разному', () => {
    expect(formatRunDuration('2026-09-07T10:00:00.000Z', '2026-09-07T10:00:42.000Z')).toBe('42 с');
    expect(formatRunDuration('2026-09-07T10:00:00.000Z', '2026-09-07T10:03:07.000Z')).toBe(
      '3 мин 7 с',
    );
  });

  it('битые или перевёрнутые отметки времени не показываются отрицательным числом', () => {
    expect(formatRunDuration('2026-09-07T10:05:00.000Z', '2026-09-07T10:00:00.000Z')).toBe('—');
    expect(formatRunDuration('не дата', '2026-09-07T10:00:00.000Z')).toBe('—');
  });
});
