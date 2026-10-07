/**
 * Порядок карточек хаба (G2): в работе — сверху, законченное — ниже, внутри
 * каждой части прежний порядок, строка разбора первой.
 */
import { describe, expect, it } from 'vitest';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { isFinishedGroup, isMrSettled, orderHubGroups } from './hubOrder';

function row(title: string, extra: Partial<ChildStageGroup> = {}): ChildStageGroup {
  return { chatId: `c-${title}`, title, stages: ['work'], isRunning: false, ...extra };
}

const titles = (groups: ChildStageGroup[]) => groups.map((group) => group.title);

describe('isFinishedGroup', () => {
  it.each<[string, Partial<ChildStageGroup>]>([
    ['доставлена', { status: 'done' }],
    ['принята', { status: 'done', acceptance: { parentChatId: 'p', index: 0, acceptedAt: 'x' } }],
    ['MR влит', { status: 'started', mrClosed: 'merged' }],
    ['MR закрыт', { mrClosed: 'closed' }],
    ['копия убрана', { status: 'failed', copy: { index: 0, cleaned: 'kept' } }],
    ['закрыта отменой плана', { status: 'failed', errorCode: 'split-group-plan-cancelled' }],
  ])('закончена: %s', (_, extra) => {
    expect(isFinishedGroup(row('г', extra))).toBe(true);
  });

  it.each<[string, Partial<ChildStageGroup>]>([
    ['идёт', { status: 'done', isRunning: true }],
    ['идёт с влитым MR (правки по ревью)', { isRunning: true, mrClosed: 'merged' }],
    ['готовится копия', { pending: 'setup', mrClosed: 'merged' }],
    ['упала', { status: 'failed' }],
    ['ждёт ответа', { waitingFor: 'question' }],
    ['на паузе', { status: 'paused', isPaused: true }],
    ['оборвана', { pending: 'interrupted' }],
    ['в очереди', { pending: 'queued' }],
    ['стоит без итога', { status: 'started' }],
    ['копия не убрана', { status: 'failed', copy: { index: 0 } }],
  ])('в работе: %s', (_, extra) => {
    expect(isFinishedGroup(row('г', extra))).toBe(false);
  });
});

describe('isMrSettled', () => {
  it('влит или закрыт и не работает — кончена совсем; идёт или готовит копию — нет', () => {
    expect(isMrSettled(row('г', { mrClosed: 'merged' }))).toBe(true);
    expect(isMrSettled(row('г', { mrClosed: 'closed' }))).toBe(true);
    expect(isMrSettled(row('г', { status: 'done' }))).toBe(false);
    expect(isMrSettled(row('г', { mrClosed: 'merged', isRunning: true }))).toBe(false);
    expect(isMrSettled(row('г', { mrClosed: 'merged', pending: 'setup' }))).toBe(false);
  });
});

describe('orderHubGroups', () => {
  it('в работе — сверху, законченные — ниже, влитые — в самом низу; внутри частей порядок прежний', () => {
    const groups = [
      row('А', { status: 'done' }),
      row('Б', { isRunning: true }),
      row('В', { mrClosed: 'merged' }),
      row('Г', { waitingFor: 'question' }),
      row('Д', { status: 'done' }),
      row('Е', { pending: 'queued', chatId: '' }),
    ];
    expect(titles(orderHubGroups(groups))).toEqual(['Б', 'Г', 'Е', 'А', 'Д', 'В']);
  });

  it('принятая, но не влитая группа стоит выше влитых и закрытых (владелец 06.10)', () => {
    const groups = [
      row('влит-1', { status: 'done', mrClosed: 'merged' }),
      row('закрыт', { status: 'done', mrClosed: 'closed' }),
      row('принята', {
        status: 'done',
        acceptance: { parentChatId: 'p', index: 2, acceptedAt: 'x' },
      }),
      row('влит-2', { status: 'done', mrClosed: 'merged' }),
      row('доставлена', { status: 'done' }),
    ];
    expect(titles(orderHubGroups(groups))).toEqual([
      'принята',
      'доставлена',
      'влит-1',
      'закрыт',
      'влит-2',
    ]);
  });

  it('строка разбора остаётся первой, даже законченная', () => {
    const groups = [
      row('А', { isRunning: true }),
      row('разбор', { stages: ['triage'], status: 'done' }),
      row('Б', { status: 'done' }),
    ];
    expect(titles(orderHubGroups(groups))).toEqual(['разбор', 'А', 'Б']);
  });

  it('ничего не теряет и не дублирует; входной список не трогает', () => {
    const groups = [row('А', { status: 'done' }), row('Б'), row('В', { status: 'done' })];
    const before = titles(groups);
    const ordered = orderHubGroups(groups);
    expect(titles(ordered).sort()).toEqual([...before].sort());
    expect(titles(groups)).toEqual(before);
  });

  it('все в работе или все закончены — порядок не меняется', () => {
    const running = [row('А'), row('Б', { isRunning: true }), row('В')];
    expect(titles(orderHubGroups(running))).toEqual(['А', 'Б', 'В']);
    const done = [row('А', { status: 'done' }), row('Б', { mrClosed: 'closed' })];
    expect(titles(orderHubGroups(done))).toEqual(['А', 'Б']);
  });
});
