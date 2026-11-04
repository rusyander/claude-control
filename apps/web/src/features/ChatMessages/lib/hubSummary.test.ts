import { describe, expect, it } from 'vitest';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { hubBucket } from './hubBucket';
import { orderHubGroups } from './orderHubGroups';
import { summarizeHub } from './summarizeHub';

function row(title: string, extra: Partial<ChildStageGroup> = {}): ChildStageGroup {
  return { chatId: `c-${title}`, title, stages: ['work'], isRunning: false, ...extra };
}

const titles = (groups: ChildStageGroup[]) => groups.map((group) => group.title);

describe('hubBucket: у каждой строки хаба есть чат — корзин три', () => {
  it('идущий прогон — «идёт», даже если прошлый ход кончился вопросом', () => {
    expect(hubBucket(row('А', { isRunning: true }))).toBe('running');
    expect(hubBucket(row('А', { isRunning: true, waitingFor: 'question' }))).toBe('running');
  });

  it('вопрос человеку без прогона — «ждёт вас»', () => {
    expect(hubBucket(row('А', { waitingFor: 'question' }))).toBe('ask');
  });

  it('ни прогона, ни вопроса — «стоит», в том числе на паузе дерева', () => {
    expect(hubBucket(row('А'))).toBe('idle');
    expect(hubBucket(row('А', { isPaused: true }))).toBe('idle');
  });

  it('счётчики сводки — по тем же корзинам; разбор и отброшенные не считаются', () => {
    const { counts } = summarizeHub(
      [
        row('А', { isRunning: true }),
        row('Б', { waitingFor: 'question' }),
        row('В'),
        row('разбор', { stages: ['triage'], isRunning: true }),
        row('старая', { retired: true }),
      ],
      0,
    );
    expect(counts).toEqual({ running: 1, ask: 1, idle: 1 });
  });

  it('время идёт до «сейчас», пока хоть что-то идёт, и до последней записи, когда всё стоит', () => {
    const start = '2026-10-22T08:00:00.000Z';
    const last = '2026-10-22T08:10:00.000Z';
    const now = Date.parse('2026-10-22T09:00:00.000Z');
    expect(summarizeHub([row('А', { startedAt: start, lastAt: last })], now).elapsedMs).toBe(
      600_000,
    );
    expect(
      summarizeHub([row('А', { startedAt: start, lastAt: last, isRunning: true })], now).elapsedMs,
    ).toBe(3_600_000);
  });
});

describe('orderHubGroups', () => {
  it('строка разбора — первой, остальные в порядке плана', () => {
    const groups = [
      row('А', { isRunning: true }),
      row('разбор', { stages: ['triage'] }),
      row('Б', { waitingFor: 'question' }),
      row('В'),
    ];
    expect(titles(orderHubGroups(groups))).toEqual(['разбор', 'А', 'Б', 'В']);
  });

  it('ничего не теряет и не дублирует; входной список не трогает', () => {
    const groups = [row('А'), row('разбор', { stages: ['triage'] }), row('Б')];
    const before = titles(groups);
    const ordered = orderHubGroups(groups);
    expect(titles(ordered).sort()).toEqual([...before].sort());
    expect(titles(groups)).toEqual(before);
  });
});
