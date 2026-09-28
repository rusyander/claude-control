import type { TFunction } from 'i18next';
import { describe, it, expect } from 'vitest';
import type { ProjectTestReport, ProjectTestRunRecord } from '@agentdeck/contracts';
import {
  automationTotal,
  formatRunDuration,
  isUnproven,
  shownCost,
  redCases,
  runTally,
  statusTotals,
  trendBars,
} from './reportMetrics';

const report = (part: Partial<ProjectTestReport>): ProjectTestReport => ({
  areas: [],
  automation: { manual: 0, toAutomate: 0, automated: 0 },
  flaky: [],
  failures: [],
  evidence: { failed: 0, proven: 0, detailed: 0, missing: [], flaky: [] },
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

describe('redCases', () => {
  const point = (caseId: string, status: ProjectTestRunRecord['results'][number]['status']) => ({
    pointId: `gui:${caseId}:${status}`,
    groupId: 'gui',
    caseId,
    status,
  });

  it('перепрогонять надо провалы и блокировки, каждый кейс по разу', () => {
    expect(
      redCases(
        run({
          id: 'r1',
          results: [
            point('gui-001', 'failed'),
            point('gui-001', 'failed'),
            point('gui-002', 'blocked'),
            point('gui-003', 'passed'),
            point('gui-004', 'skipped'),
          ],
        }),
      ),
    ).toEqual(['gui-001', 'gui-002']);
  });

  it('нераскрытая запись прогона кнопку не рисует, а не падает', () => {
    expect(redCases(undefined)).toEqual([]);
    expect(redCases(run({ id: 'r1' }))).toEqual([]);
  });
});

describe('formatRunDuration', () => {
  // Единицы — словарём языка: английская запись прогона показывала «15 с».
  const en = ((key: string) =>
    ({ 'common.duration.m': 'm', 'common.duration.s': 's' })[key] ?? key) as unknown as TFunction;

  it('идущий прогон длительности ещё не имеет', () => {
    expect(formatRunDuration('2026-09-07T10:00:00.000Z', undefined, en)).toBe('—');
  });

  it('секунды и минуты — единицами языка интерфейса', () => {
    expect(formatRunDuration('2026-09-07T10:00:00.000Z', '2026-09-07T10:00:42.000Z', en)).toBe(
      '42s',
    );
    expect(formatRunDuration('2026-09-07T10:00:00.000Z', '2026-09-07T10:03:07.000Z', en)).toBe(
      '3m 07s',
    );
  });

  it('битые или перевёрнутые отметки времени не показываются отрицательным числом', () => {
    expect(formatRunDuration('2026-09-07T10:05:00.000Z', '2026-09-07T10:00:00.000Z', en)).toBe('—');
    expect(formatRunDuration('не дата', '2026-09-07T10:00:00.000Z', en)).toBe('—');
  });
});

/**
 * Строка прогона в истории: прерванный и идущий не выглядят завершёнными,
 * заблокированное не прячется в «пропущено», а брошенные непройденными
 * проходы названы числом, а не пропадают из счёта.
 */
describe('runTally', () => {
  const summary = { total: 6, passed: 2, failed: 2, skipped: 1, blocked: 1 };
  const base = { id: 'r', mode: 'manual', actor: 'human', startedAt: '', results: [], summary };

  it('блокировка отдельно от пропуска, непройденное названо, завершённый без пометки', () => {
    expect(runTally({ ...base, status: 'done', planned: 7 } as ProjectTestRunRecord)).toEqual({
      passed: 2,
      failed: 2,
      skipped: 1,
      blocked: 1,
      open: 1,
      state: undefined,
      counted: true,
    });
  });

  it('прерванный, идущий и упавший прогоны помечены; без плана непройденного нет', () => {
    const tally = (status: string) =>
      runTally({ ...base, status } as unknown as ProjectTestRunRecord);
    expect(tally('stopped').state).toBe('stopped');
    expect(tally('running').state).toBe('running');
    expect(tally('error').state).toBe('error');
    expect(tally('stopped').open).toBe(0);
  });

  /**
   * Генерация и автоматизация кейсы не проходят: их сводка пуста всегда, и
   * «пройдено: 0 · провалено: 0» зелёным и красным читалось как прогон,
   * который ничего не нашёл. Прогон кейсов с пустым итогом — счёт показывает.
   */
  it('у записи, которая кейсы не проходит, счёта нет; у прогона кейсов — есть даже нулевой', () => {
    const empty = { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 };
    const of = (mode: string) =>
      runTally({
        ...base,
        mode,
        status: 'done',
        summary: empty,
      } as unknown as ProjectTestRunRecord);
    expect(of('generate').counted).toBe(false);
    expect(of('automate').counted).toBe(false);
    expect(of('explore').counted).toBe(false);
    expect(of('run').counted).toBe(true);
    expect(of('manual').counted).toBe(true);
    expect(
      runTally({ ...base, mode: 'explore', status: 'done' } as unknown as ProjectTestRunRecord)
        .counted,
    ).toBe(true);
  });
});

/**
 * Пометка «нет доказательства» у прохода. Ставилась по одному признаку — нет
 * снимка, — и красный проход с номером шага, ожиданием и фактом носил её рядом
 * с пометкой «шаг 2»: доказан и не доказан одновременно.
 */
describe('isUnproven', () => {
  const point = { pointId: 'p', groupId: 'g', caseId: 'c' };

  it('красный без снимка и без разбора — не доказан; с любым из двух — доказан', () => {
    expect(isUnproven({ ...point, status: 'failed' })).toBe(true);
    expect(isUnproven({ ...point, status: 'failed', failure: { step: 2 } })).toBe(false);
    expect(isUnproven({ ...point, status: 'blocked', failure: { actual: 'нет учётки' } })).toBe(
      false,
    );
    expect(isUnproven({ ...point, status: 'failed', attachments: ['a.png'] })).toBe(false);
    expect(isUnproven({ ...point, status: 'passed' })).toBe(false);
  });
});

/**
 * «Стоимость: $0.00» в отчёте рядом с миллионом токенов: прогоны по подписке
 * цены не несут, и ноль значил «неизвестно», а читался «бесплатно». История
 * прогонов ноль уже прятала — отчёт показывал.
 */
describe('shownCost', () => {
  it('нулевая и отсутствующая цена не показываются, настоящая — с центами', () => {
    expect(shownCost(0)).toBeUndefined();
    expect(shownCost(undefined)).toBeUndefined();
    expect(shownCost(1.234)).toBe('1.23');
  });
});
