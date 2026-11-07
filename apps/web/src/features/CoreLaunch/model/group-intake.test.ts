import { describe, expect, it } from 'vitest';
import type { AskView, TaskView } from '@agentdeck/contracts/core/task-view';
import {
  awaitsClassAnswer,
  classWaitingOf,
  confirmGroupIntake,
  type GroupIntakeDeps,
  intakeStepOf,
  pendingIntakeCount,
} from './groupIntake';

/**
 * Карточки приёма группы одной кнопкой (этап 11, W3-18): КАЖДОЙ задаче с открытым вопросом
 * карточки — тот же ответ, что в её ленте («Подтвердить карточку»); подтверждённой — ничего;
 * отказ одной назван и не держит остальные; неизвестный исход — повтор тем же `cmdId`.
 */

type View = Pick<TaskView, 'state' | 'asks'>;

/** Вопрос `aN` — вопрос карточки задачи `tN` (ключ `intake:tN`), если не сказано иное. */
const ask = (askId: string, over: Partial<AskView> = {}): AskView => ({
  askId,
  state: 'open',
  point: 10,
  source: 'intake',
  dedupe: `intake:t${askId.slice(1)}`,
  stepId: null,
  lateAnswer: false,
  answer: null,
  ...over,
});
/** Вопрос класса задачи `taskId`: тот же источник `intake`, ключ `classify:<taskId>`. */
const classAsk = (askId: string, taskId: string): AskView =>
  ask(askId, { dedupe: `classify:${taskId}` });
/** Оценка держит задачу: вопрос карточки открыт. */
const asking = (askId: string): View => ({ state: 'estimating', asks: [ask(askId)] });
const confirmedView = (askId: string): View => ({
  state: 'estimating',
  asks: [ask(askId, { state: 'answered', answer: 'Подтвердить карточку' })],
});

interface Sent {
  taskId: string;
  fields: { askId: string; answer: string };
  cmdId: string;
}

/** Ядро-двойник: вид меняет только применённый ответ, повтор `cmdId` — сохранённый исход. */
function fakeCore(views: Record<string, View | null>, refuse: Record<string, string | 'network'>) {
  const sent: Sent[] = [];
  const outcomes = new Map<string, boolean>();
  let n = 0;
  const deps: GroupIntakeDeps = {
    view: async (id) => views[id] ?? null,
    send: async (taskId, fields, cmdId) => {
      sent.push({ taskId, fields, cmdId });
      const known = outcomes.get(cmdId);
      if (known !== undefined)
        return known ? { ok: true } : { ok: false, reason: 'x', keep: false };
      // Как ядро (`leadAnswerFits`): подпись карточки на вопрос класса — отказ `unknown-option`.
      const target = views[taskId]?.asks.find((a) => a.askId === fields.askId);
      if (target?.dedupe !== `intake:${taskId}`) {
        outcomes.set(cmdId, false);
        return { ok: false, reason: 'unknown-option: answer is none of the options', keep: false };
      }
      const why = refuse[taskId];
      if (why === 'network') return { ok: false, reason: 'network down', keep: true };
      if (why) {
        outcomes.set(cmdId, false);
        return { ok: false, reason: why, keep: false };
      }
      outcomes.set(cmdId, true);
      const before = views[taskId]?.asks ?? [];
      views[taskId] = {
        state: 'estimating',
        asks: before.map((a) =>
          a.askId === fields.askId ? { ...a, state: 'answered', answer: fields.answer } : a,
        ),
      };
      return { ok: true };
    },
    newId: () => `cmd-${(n += 1)}`,
  };
  return { deps, sent };
}

describe('group intake confirm answers every pending card of the group (W3-18)', () => {
  it('every task with an open card ask gets the feed answer «Подтвердить карточку» on its own ask', async () => {
    const { deps, sent } = fakeCore({ t0: asking('a0'), t1: asking('a1'), t2: asking('a2') }, {});
    const rows = await confirmGroupIntake(['t0', 't1', 't2'], deps, new Map());
    expect(rows.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(sent.map((s) => [s.taskId, s.fields])).toEqual([
      ['t0', { askId: 'a0', answer: 'Подтвердить карточку' }],
      ['t1', { askId: 'a1', answer: 'Подтвердить карточку' }],
      ['t2', { askId: 'a2', answer: 'Подтвердить карточку' }],
    ]);
    expect(new Set(sent.map((s) => s.cmdId)).size).toBe(3);
  });

  it('a class question is never answered: card auto-accepted, classify in alwaysAsk → skipped, no command, no unknown-option', async () => {
    // Карточка принята сама (вопроса карточки нет), класс спрошен (`classify` в alwaysAsk).
    const { deps, sent } = fakeCore(
      { t0: { state: 'estimating', asks: [classAsk('c0', 't0')] }, t1: asking('a1') },
      {},
    );
    const rows = await confirmGroupIntake(['t0', 't1'], deps, new Map());
    expect(rows).toEqual([
      { taskId: 't0', status: 'skipped' },
      { taskId: 't1', status: 'confirmed' },
    ]);
    expect(sent.map((s) => [s.taskId, s.fields.askId])).toEqual([['t1', 'a1']]);
  });

  it('the English panel sends the English label (the core accepts either)', async () => {
    const { deps, sent } = fakeCore({ t0: asking('a0') }, {});
    await confirmGroupIntake(['t0'], deps, new Map(), 'en');
    expect(sent[0]?.fields.answer).toBe('Confirm the card');
  });

  it('a refused task is named, the others are still confirmed', async () => {
    const { deps } = fakeCore(
      { t0: asking('a0'), t1: asking('a1'), t2: asking('a2') },
      { t1: 'already-answered: ask a1 is already answered' },
    );
    const rows = await confirmGroupIntake(['t0', 't1', 't2'], deps, new Map());
    expect(rows).toEqual([
      { taskId: 't0', status: 'confirmed' },
      {
        taskId: 't1',
        status: 'refused',
        why: null,
        reason: 'already-answered: ask a1 is already answered',
      },
      { taskId: 't2', status: 'confirmed' },
    ]);
  });

  it('a retry touches only the rest: a confirmed task gets no command, an unknown outcome reuses its cmdId', async () => {
    const views: Record<string, View | null> = { t0: asking('a0'), t1: asking('a1') };
    const { deps, sent } = fakeCore(views, { t1: 'network' });
    const cmdIds = new Map<string, string>();
    const first = await confirmGroupIntake(['t0', 't1'], deps, cmdIds);
    expect(first.map((r) => r.status)).toEqual(['confirmed', 'refused']);
    const t1Cmd = sent.find((s) => s.taskId === 't1')?.cmdId;
    // Сеть вернулась: повтор — тот же ключ у t1, t0 уже подтверждена и пропущена.
    const { deps: healed, sent: again } = fakeCore(views, {});
    const second = await confirmGroupIntake(['t0', 't1'], healed, cmdIds);
    expect(second.map((r) => r.status)).toEqual(['skipped', 'confirmed']);
    expect(again.map((s) => [s.taskId, s.cmdId])).toEqual([['t1', t1Cmd]]);
  });

  it('a core refusal drops the key: the next press is a new command', async () => {
    const { deps, sent } = fakeCore({ t0: asking('a0') }, { t0: 'unknown-ask' });
    const cmdIds = new Map<string, string>();
    await confirmGroupIntake(['t0'], deps, cmdIds);
    await confirmGroupIntake(['t0'], deps, cmdIds);
    expect(sent.map((s) => s.cmdId)).toEqual(['cmd-1', 'cmd-2']);
  });

  it('a view that fails to load or an ended task is a named row, never a command', async () => {
    const { deps, sent } = fakeCore(
      { t0: null, t1: { state: 'cancelled', asks: [ask('a1')] } },
      {},
    );
    const failing: GroupIntakeDeps = {
      ...deps,
      view: async (id) => {
        if (id === 'tx') throw new Error('core-unreachable');
        return deps.view(id);
      },
    };
    const rows = await confirmGroupIntake(['t0', 't1', 'tx'], failing, new Map());
    expect(rows).toEqual([
      { taskId: 't0', status: 'refused', why: 'no-view', reason: '' },
      { taskId: 't1', status: 'refused', why: 'ended', reason: '' },
      { taskId: 'tx', status: 'refused', why: null, reason: 'core-unreachable' },
    ]);
    expect(sent).toEqual([]);
  });
});

describe('group intake step by the task view', () => {
  it('only an open ask keyed intake:<taskId> is pending; a running task, no ask, or other sources are done', () => {
    expect(intakeStepOf('t0', asking('a0'))).toEqual({ kind: 'answer', askId: 'a0' });
    expect(intakeStepOf('t0', { state: 'running', asks: [ask('a0')] })).toEqual({ kind: 'done' });
    expect(intakeStepOf('t0', { state: 'estimating', asks: [] })).toEqual({ kind: 'done' });
    const permit = ask('p0', { source: 'permit', dedupe: null });
    expect(intakeStepOf('t0', { state: 'estimating', asks: [permit] })).toEqual({ kind: 'done' });
    // Чужой ключ (вопрос карточки другой задачи) — не вопрос этой задачи.
    expect(intakeStepOf('t1', asking('a0'))).toEqual({ kind: 'done' });
  });

  it('the class question is never this button: confirmed or auto card, open classify ask → done', () => {
    const confirmed: View = {
      state: 'estimating',
      asks: [ask('a0', { state: 'answered', answer: 'Confirm the card' }), classAsk('c0', 't0')],
    };
    expect(intakeStepOf('t0', confirmed)).toEqual({ kind: 'done' });
    const auto: View = { state: 'estimating', asks: [classAsk('c0', 't0')] };
    expect(intakeStepOf('t0', auto)).toEqual({ kind: 'done' });
    // Оба вопроса открыты разом: кнопка отвечает карточке, класс остаётся человеку в ленте.
    const both: View = { state: 'estimating', asks: [classAsk('c0', 't0'), ask('a0')] };
    expect(intakeStepOf('t0', both)).toEqual({ kind: 'answer', askId: 'a0' });
  });

  it('class waiting: only an open classify:<taskId> ask of a task not ended or launched, numbered in the group', () => {
    const auto: View = { state: 'estimating', asks: [classAsk('c0', 't0')] };
    expect(awaitsClassAnswer('t0', auto)).toBe(true);
    // Чужой ключ, вопрос карточки, отвеченный класс, запущенная или кончившаяся задача — не ждёт.
    expect(awaitsClassAnswer('t1', auto)).toBe(false);
    expect(awaitsClassAnswer('t0', asking('a0'))).toBe(false);
    const answered: View = {
      state: 'estimating',
      asks: [{ ...classAsk('c0', 't0'), state: 'answered', answer: 'M' }],
    };
    expect(awaitsClassAnswer('t0', answered)).toBe(false);
    expect(awaitsClassAnswer('t0', { ...auto, state: 'running' })).toBe(false);
    expect(awaitsClassAnswer('t0', { ...auto, state: 'cancelled' })).toBe(false);
    expect(awaitsClassAnswer('t0', null)).toBe(false);
    expect(
      classWaitingOf([
        ['t0', auto],
        ['t1', asking('a1')],
        [
          't2',
          { state: 'estimating', asks: [classAsk('c2', 't2'), ask('a2', { dedupe: 'intake:t2' })] },
        ],
        ['t3', undefined],
      ]),
    ).toEqual([
      { taskId: 't0', n: 1 },
      { taskId: 't2', n: 3 },
    ]);
  });

  it('the pending count is the tasks the button would answer', () => {
    const auto: View = { state: 'estimating', asks: [classAsk('c3', 't3')] };
    expect(
      pendingIntakeCount([
        ['t0', asking('a0')],
        ['t1', confirmedView('a1')],
        ['t2', undefined],
        ['tx', null],
        ['t3', auto],
        ['t4', asking('a4')],
      ]),
    ).toBe(2);
  });
});
