import { describe, expect, it } from 'vitest';
import type { SseEvent } from '@entities/CoreTask';
import { EMPTY_FOLD, foldEvent, foldEvents, parseLine } from './fold';

/**
 * Свёртка ленты для показа (F3): строки потока → строки ленты по времени и факты вопросов.
 * Повтор номера после переподключения (поток без `Last-Event-ID` отдаёт журнал заново) не должен
 * дублировать строки — это и проверяется первым.
 */

const STEP = '01900000-0000-7000-8000-000000000101';
const UNIT = '01900000-0000-7000-8000-000000000201';
const ASK = '01900000-0000-7000-8000-000000000301';
const SPLIT = '01900000-0000-7000-8000-000000000401';

function ev(seq: number, kind: string, data: unknown, extra: Record<string, unknown> = {}) {
  const line = { v: 1, seq, at: 1_700_000_000_000 + seq, kind, data, ...extra };
  return { id: String(seq), event: kind, data: JSON.stringify(line) } satisfies SseEvent;
}

const decision = (seq: number, cls: string, output: unknown, reasons: string[] = []) =>
  ev(seq, 'decision', { decisionId: `d-${seq}`, class: cls, reasons, output });

describe('свёртка ленты: повтор потока', () => {
  it('повтор строк с уже свёрнутыми номерами не дублирует строки ленты', () => {
    const lines = [
      ev(1, 'task.created', { title: 'Починить вход' }),
      decision(2, 'check', { kind: 'run' }, ['no record for the tree']),
      ev(3, 'signal', { signal: 'stall', severity: 'warn', subject: 's', detail: 'd' }),
    ];
    const once = foldEvents(lines);
    // Переподключение без Last-Event-ID: ядро отдаёт журнал с начала, и следом новая строка.
    const again = foldEvents([...lines, ev(4, 'task.ended', { outcome: 'done' })], once);
    expect(again.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(again.lastSeq).toBe(4);
  });

  it('строка с меньшим номером после большего тоже отбрасывается — порядок ленты по журналу', () => {
    const fold = foldEvents([ev(5, 'task.created', { title: 'a' }), ev(3, 'error', { code: 'x' })]);
    expect(fold.rows.map((r) => r.seq)).toEqual([5]);
  });

  it('не JSON и строка без номера не свёртываются и не сдвигают номер', () => {
    expect(parseLine({ event: 'x', data: 'not json' })).toBeNull();
    expect(parseLine({ event: 'x', data: JSON.stringify({ kind: 'decision' }) })).toBeNull();
    const fold = foldEvent(EMPTY_FOLD, { event: 'x', data: 'oops' });
    expect(fold).toBe(EMPTY_FOLD);
  });
});

describe('свёртка ленты: строки', () => {
  it('решение несёт класс, исход по decisionOutcome и причины дословно', () => {
    const fold = foldEvents([decision(1, 'permit', { allow: false }, ['path outside unit'])]);
    expect(fold.rows[0]!.item).toEqual({
      type: 'decision',
      decisionId: 'd-1',
      cls: 'permit',
      outcome: 'deny',
      reasons: ['path outside unit'],
    });
  });

  it('служебная строка — только счёт, данные артефактом — честная строка', () => {
    const fold = foldEvents([
      ev(1, 'usage', { input: 1 }),
      ev(2, 'decision', null, { dataRef: 'a'.repeat(64) }),
      ev(3, 'usage', null),
    ]);
    expect(fold.hidden).toBe(2);
    expect(fold.rows.map((r) => r.item.type)).toEqual(['in-artifact']);
  });

  it('конец шага с неизвестным исходом не выдумывается — строка скрыта', () => {
    const fold = foldEvents([ev(1, 'step.ended', { outcome: 'weird' })]);
    expect(fold.rows).toHaveLength(0);
    expect(fold.hidden).toBe(1);
  });

  it('сигнал с неизвестной важностью читается как сведения, действие — как записано', () => {
    const fold = foldEvents([
      ev(1, 'signal', {
        signal: 'loop',
        severity: '???',
        subject: 'Bash',
        detail: 'x',
        action: 'hint',
      }),
    ]);
    expect(fold.rows[0]!.item).toMatchObject({ severity: 'info', action: 'hint' });
  });
});

describe('свёртка ленты: факты вопросов', () => {
  it('вопрос права знает цель отказа (cause → permit) и проект единицы шага', () => {
    const fold = foldEvents([
      ev(1, 'unit.created', { unitId: UNIT, repoKey: 'repo-a' }),
      ev(2, 'step.started', {
        stepId: STEP,
        unitId: UNIT,
        stepKind: 'implement',
        stepDefId: 'i',
        round: 0,
      }),
      ev(3, 'decision', {
        decisionId: 'd-3',
        class: 'permit',
        reasons: [],
        output: { allow: false, action: 'edit', target: 'infra/main.tf' },
      }),
      ev(
        4,
        'human.asked',
        {
          askId: ASK,
          point: 5,
          source: 'permit',
          question: 'grant?',
          options: ['grant', 'refuse'],
        },
        { stepId: STEP, cause: 3 },
      ),
    ]);
    expect(fold.asks[ASK]).toMatchObject({
      point: 5,
      stepId: STEP,
      permit: { action: 'edit', target: 'infra/main.tf' },
      repoKey: 'repo-a',
      splitId: null,
      answer: null,
    });
  });

  it('вопрос запуска несёт деление из ключа split:, ответ закрывает факт', () => {
    const fold = foldEvents([
      ev(1, 'human.asked', {
        askId: ASK,
        point: 10,
        source: 'launch',
        question: 'launch?',
        options: ['approve-split', 'edit-split', 'cancel'],
        dedupe: `split:${SPLIT}`,
      }),
      ev(2, 'human.answered', { askId: ASK, answer: 'approve-split', channel: 'panel' }),
    ]);
    expect(fold.asks[ASK]!.splitId).toBe(SPLIT);
    expect(fold.asks[ASK]!.answer).toEqual({ text: 'approve-split', channel: 'panel' });
  });
});
