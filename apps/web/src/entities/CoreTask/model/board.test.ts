import { describe, expect, it } from 'vitest';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import {
  STAGE_COLUMNS,
  cardsByColumn,
  filterCards,
  groupIdsOf,
  groupLaneCount,
  lanesOf,
  moveTargetOf,
  moveUp,
  openedCardOf,
  shownMoves,
  waitingCount,
  windowCardOf,
} from './board';

describe('opened card window', () => {
  it('keeps the window on an entry that the core started: the task card carrying its entryId', () => {
    const entry = card('e1', { kind: 'entry', entryId: 'e1', taskId: undefined, column: 'queue' });
    const task = card('t1', { entryId: 'e1', column: 'work' });
    expect(openedCardOf([entry], 'e1')).toBe(entry);
    expect(openedCardOf([task, card('t2')], 'e1')).toBe(task);
    expect(openedCardOf([task], 't1')).toBe(task);
    expect(openedCardOf([task], 'gone')).toBeUndefined();
    expect(openedCardOf([task], null)).toBeUndefined();
  });
});

describe('window card while a move from it is in flight or refused', () => {
  const entry = card('e1', { kind: 'entry', entryId: 'e1', taskId: undefined, column: 'inbox' });
  const task = card('t1', { entryId: 'e1', column: 'work' });

  it('a refused move whose card left the board (another page rejected it): the window keeps the snapshot, marked stale', () => {
    expect(windowCardOf([], 'e1', { card: entry, phase: 'refused' })).toEqual({
      card: entry,
      stale: true,
    });
  });

  it('a refused move whose entry started as a task meanwhile: the window stays on the entry instead of morphing into the task', () => {
    expect(windowCardOf([task], 'e1', { card: entry, phase: 'refused' })).toEqual({
      card: entry,
      stale: true,
    });
  });

  it('a move still in flight while the board reread drops the card: the window does not close mid-request', () => {
    expect(windowCardOf([], 'e1', { card: entry, phase: 'pending' })).toEqual({
      card: entry,
      stale: true,
    });
  });

  it('the card is still on the board: the window shows its live version, not the snapshot', () => {
    const fresh = { ...entry, title: 'renamed' };
    expect(windowCardOf([fresh], 'e1', { card: entry, phase: 'refused' })).toEqual({
      card: fresh,
      stale: false,
    });
  });

  it('an accepted move follows the board: a rejected card closes the window, a started one is followed', () => {
    expect(windowCardOf([], 'e1', { card: entry, phase: 'done' })).toEqual({
      card: undefined,
      stale: false,
    });
    expect(windowCardOf([task], 'e1', { card: entry, phase: 'done' })).toEqual({
      card: task,
      stale: false,
    });
  });

  it('no window open or no move sent: plain openedCardOf', () => {
    expect(windowCardOf([entry], null, { card: entry, phase: 'refused' })).toEqual({
      card: undefined,
      stale: false,
    });
    expect(windowCardOf([], 'e1', null)).toEqual({ card: undefined, stale: false });
  });
});

/** Карточка доски с умолчаниями; поля, важные тесту, — явно. */
function card(id: string, extra: Partial<BoardCard> = {}): BoardCard {
  return {
    kind: 'task',
    id,
    taskId: id,
    column: 'work',
    title: id,
    stop: 'mr',
    waiting: false,
    questions: 0,
    takeover: null,
    moves: [],
    createdAt: 1,
    ...extra,
  };
}

describe('core board layout', () => {
  it('stage columns follow the contract order and leave «closed» to the folded block', () => {
    expect(STAGE_COLUMNS[0]).toBe('inbox');
    expect(STAGE_COLUMNS).not.toContain('closed');
    expect(STAGE_COLUMNS).toContain('waiting');
  });

  it('the waiting count is the core flag on cards, not a recount of their questions', () => {
    const cards = [
      card('a', { waiting: true, questions: 0 }),
      // Неблокирующие вопросы — значок, а не «ждёт вас».
      card('b', { waiting: false, questions: 3 }),
      card('c', { waiting: true, questions: 2 }),
    ];
    expect(waitingCount({ cards })).toBe(2);
  });

  it('inbox and queue keep the human rank; other columns go by start, then creation', () => {
    const by = cardsByColumn([
      card('q2', { column: 'queue', rank: 2, createdAt: 1 }),
      card('q1', { column: 'queue', rank: 1, createdAt: 9 }),
      card('w-late', { column: 'work', startedAt: 50, createdAt: 1 }),
      card('w-early', { column: 'work', startedAt: 10, createdAt: 2 }),
    ]);
    expect(by.queue.map((c) => c.id)).toEqual(['q1', 'q2']);
    expect(by.work.map((c) => c.id)).toEqual(['w-early', 'w-late']);
    expect(by.review).toEqual([]);
  });

  it('lanes group cards by the core groupId; cards without a group stay out of lane mode', () => {
    const cards = [
      card('a1', { groupId: 'grp-a', createdAt: 5 }),
      card('b1', { groupId: 'grp-b', createdAt: 1 }),
      card('a2', { groupId: 'grp-a', createdAt: 6 }),
      card('solo'),
    ];
    const lanes = lanesOf(cards);
    expect(lanes.map((l) => [l.groupId, l.cards.length])).toEqual([
      ['grp-b', 1],
      ['grp-a', 2],
    ]);
    expect(groupIdsOf(cards)).toEqual(['grp-b', 'grp-a']);
  });

  // Число у «Группы» в меню и сводке: раньше там стояло число прежних наборов настроек (11 при
  // пустых полосах), а ссылка вела в полосы доски.
  it('group lane count = lanes of open cards; closed and ungrouped cards give none', () => {
    const cards = [
      card('a1', { groupId: 'grp-a' }),
      card('a2', { groupId: 'grp-a', column: 'review' }),
      card('b1', { groupId: 'grp-b', column: 'closed' }),
      card('solo'),
    ];
    expect(groupLaneCount(cards)).toBe(1);
    expect(groupLaneCount([])).toBe(0);
  });

  it('filters narrow to one group and to waiting cards', () => {
    const cards = [
      card('a', { groupId: 'g', waiting: true }),
      card('b', { groupId: 'g' }),
      card('c', { waiting: true }),
    ];
    expect(filterCards(cards, { group: 'g' }).map((c) => c.id)).toEqual(['a', 'b']);
    expect(filterCards(cards, { waitingOnly: true }).map((c) => c.id)).toEqual(['a', 'c']);
    expect(filterCards(cards, {}).length).toBe(3);
  });
});

describe('core board moves', () => {
  it('an entry moves by entryId, a task (even one started from the board) by taskId', () => {
    expect(moveTargetOf(card('e', { kind: 'entry', entryId: 'e', taskId: undefined }))).toEqual({
      entryId: 'e',
    });
    expect(moveTargetOf(card('t', { entryId: 'e0', taskId: 't' }))).toEqual({ taskId: 't' });
  });

  it('only the moves the core allowed are shown, in a fixed order', () => {
    expect(shownMoves(card('x', { moves: ['rejected', 'work', 'inbox'] }))).toEqual([
      'work',
      'inbox',
      'rejected',
    ]);
    expect(shownMoves(card('y', { moves: [] }))).toEqual([]);
  });

  it('«Up» places the card before its upper neighbour, only when the core allows the column move', () => {
    const top = card('top', { kind: 'entry', entryId: 'top', column: 'queue', moves: ['queue'] });
    const low = card('low', { kind: 'entry', entryId: 'low', column: 'queue', moves: ['queue'] });
    const column = [top, low];
    expect(moveUp(low, column)).toEqual({ to: 'queue', before: 'top' });
    expect(moveUp(top, column)).toBeUndefined();
    expect(moveUp({ ...low, moves: ['work'] }, column)).toBeUndefined();
    expect(moveUp(card('w', { column: 'work', moves: ['queue'] }), [])).toBeUndefined();
  });
});
