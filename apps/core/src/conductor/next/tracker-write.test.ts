import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { initialState, reduce } from '../../journal/reduce/reduce.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { presetOf } from '../scenario/presets.ts';
import { decideNext } from './next.ts';
import { parseTrackerWriteDedupe, trackerWriteDedupe } from './tracker-write.ts';

/**
 * Конец задачи и вопрос пункта 9 о комментарии назад в тикет (этап 12, P166, W2-D): чистый суд
 * `decideNext` над свёрткой. Единица закрыта, сценарий без публикации — без вопроса задача
 * кончается; с открытым вопросом или «разрешить» без действия записи — ждёт.
 */

const TASK = newId();
const SCENARIO = presetOf({ id: 'review-only', version: 1 })!;
const TICKET = 'PROJ-2';
type Add = (kind: JournalKind, data: unknown) => void;

function settled(more: (add: Add, unitId: string) => void = () => undefined): TaskFoldState {
  let state: TaskFoldState = initialState(TASK);
  let seq = 0;
  const add: Add = (kind, data) => {
    seq += 1;
    const line = { v: 1, seq, at: seq, mono: seq * 1000, bootId: TASK, taskId: TASK };
    state = reduce(state, { ...line, kind, actor: 'core', data } as JournalLine);
  };
  const unitId = newId();
  add('task.created', {
    title: 't',
    repos: [],
    build: 'b',
    scenario: { id: 'review-only', version: 1 },
    profilePins: [],
    modelCeiling: null,
    userLayerHash: null,
    envPin: '',
    requirementsSource: 'text',
    allowedRoutes: [],
    routesSourceLevel: 2,
    origin: null,
    launchPolicy: 'auto',
    ciWait: false,
  });
  add('task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' });
  add('unit.created', {
    unitId,
    name: 'u',
    repoKey: 'r1',
    branch: 'b',
    ownedPaths: [],
    after: [],
    contract: false,
    splitId: null,
  });
  add('unit.transition', { unitId, event: 'start', from: 'planned', to: 'running' });
  add('unit.transition', { unitId, event: 'close', from: 'running', to: 'closed' });
  more(add, unitId);
  return state;
}

function ask(add: Add, unitId: string): string {
  const askId = newId();
  add('human.asked', {
    askId,
    point: 9,
    question: 'q',
    options: ['Allow the comment', 'Do not write'],
    defaultAction: null,
    source: 'tracker-write',
    dedupe: trackerWriteDedupe(TICKET, unitId),
  });
  return askId;
}

function answer(add: Add, askId: string, text: string, channel = 'panel'): void {
  add('ask.transition', { askId, event: 'answer', from: 'open', to: 'answered' });
  add('human.answered', { askId, answer: text, channel });
}

function wrote(add: Add): void {
  add('action.started', {
    actionId: newId(),
    kind: 'tracker-write',
    target: TICKET,
    idempotencyHint: 'comment',
  });
}

const next = (state: TaskFoldState) =>
  decideNext({ state, scenario: SCENARIO, workNowMs: 0, live: {} }).action;

describe('task end waits for the point-9 tracker write (W2-D, P166)', () => {
  it('no tracker-write ask: the settled task finishes', () => {
    expect(next(settled())).toEqual({ kind: 'finish-task' });
  });

  it('an open ask holds the end, named', () => {
    let dedupe = '';
    const state = settled((add, unitId) => {
      ask(add, unitId);
      dedupe = trackerWriteDedupe(TICKET, unitId);
    });
    expect(next(state)).toEqual({
      kind: 'wait',
      reason: `tracker write awaits the human (point 9): ${dedupe}`,
    });
  });

  it('approved without a tracker-write action holds; the action (any outcome) releases the end', () => {
    const approved = settled((add, unitId) => answer(add, ask(add, unitId), 'Allow the comment'));
    expect(next(approved)).toMatchObject({
      kind: 'wait',
      reason: expect.stringContaining('tracker write approved, not yet run'),
    });
    const written = settled((add, unitId) => {
      answer(add, ask(add, unitId), 'Разрешить комментарий');
      wrote(add);
    });
    expect(next(written)).toEqual({ kind: 'finish-task' });
  });

  it('a decline never holds the end', () => {
    const state = settled((add, unitId) => answer(add, ask(add, unitId), 'Do not write'));
    expect(next(state)).toEqual({ kind: 'finish-task' });
  });

  it('the latest ask of the key decides: a re-raised ask after a Telegram approval holds, its decline releases', () => {
    const reasked = settled((add, unitId) => {
      answer(add, ask(add, unitId), 'Allow the comment', 'telegram');
      ask(add, unitId);
    });
    expect(next(reasked)).toMatchObject({
      kind: 'wait',
      reason: expect.stringContaining('awaits the human'),
    });
    const declined = settled((add, unitId) => {
      answer(add, ask(add, unitId), 'Allow the comment', 'telegram');
      answer(add, ask(add, unitId), 'Do not write');
    });
    expect(next(declined)).toEqual({ kind: 'finish-task' });
  });

  it('the dedupe key round-trips; a foreign key parses to null', () => {
    const unitId = newId();
    expect(parseTrackerWriteDedupe(trackerWriteDedupe(TICKET, unitId))).toEqual({
      key: TICKET,
      unitId,
    });
    expect(parseTrackerWriteDedupe('split:1')).toBeNull();
    expect(parseTrackerWriteDedupe('tracker-write:PROJ-2:')).toBeNull();
    expect(parseTrackerWriteDedupe(null)).toBeNull();
  });
});
