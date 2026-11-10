import { describe, expect, it } from 'vitest';
import type { AskEntry } from '../human/human.types.ts';
import { judgeTelegramScope } from './telegram-scope.ts';

/**
 * Суд области Telegram (этап 12, D29, P187, critic B3) — таблица точка × источник × ответ. Сужающий
 * ответ проходит всегда; открывающий точке 3 и решающий сверке — только панель или телефон; свой
 * текст — только `ask_human`, `blocker`, `scenario-step`; вопрос должен быть открыт.
 */

const ID = '019a0000-0000-7000-8000-0000000000a1';

function ask(over: Partial<AskEntry>): Record<string, AskEntry> {
  const entry: AskEntry = {
    askId: ID,
    point: 6,
    source: 'ask_human',
    dedupe: null,
    stepId: null,
    sessionId: null,
    question: 'q',
    options: [],
    defaultAction: null,
    blocking: true,
    askedAt: 0,
    askedSeq: 1,
    state: 'open',
    reminders: 0,
    lastReminderAt: null,
    answers: [],
    ...over,
  };
  return { [ID]: entry };
}

const answer = (text: string) => ({ kind: 'answer' as const, fields: { askId: ID, answer: text } });

describe('judgeTelegramScope: point × source × answer (stage 12, D29, B3)', () => {
  it.each([
    [
      'point 5 grant opens only the asked call',
      { source: 'permit', point: 5, options: ['grant', 'refuse'] },
      'grant',
      true,
    ],
    [
      'point 5 refuse',
      { source: 'permit', point: 5, options: ['grant', 'refuse'] },
      'refuse',
      true,
    ],
    [
      'point 3 allow is refused',
      { source: 'permit', point: 3, options: ['allow', 'refuse'] },
      'allow',
      false,
    ],
    [
      'point 3 grant is refused',
      { source: 'permit', point: 3, options: ['allow', 'refuse'] },
      'grant',
      false,
    ],
    [
      'point 3 refuse passes',
      { source: 'permit', point: 3, options: ['allow', 'refuse'] },
      'refuse',
      true,
    ],
    [
      'permit free text is refused',
      { source: 'permit', point: 5, options: ['grant', 'refuse'] },
      'do it',
      false,
    ],
    [
      'reconcile done (en) is refused',
      {
        source: 'reconcile',
        point: 4,
        options: ['Check again', 'Treat as done', 'Treat as not done'],
      },
      'Treat as done',
      false,
    ],
    [
      'reconcile notDone (ru) is refused',
      {
        source: 'reconcile',
        point: 4,
        options: ['повторить сверку', 'считать выполненным', 'считать невыполненным'],
      },
      'считать невыполненным',
      false,
    ],
    [
      'reconcile recheck passes',
      {
        source: 'reconcile',
        point: 4,
        options: ['Check again', 'Treat as done', 'Treat as not done'],
      },
      'Check again',
      true,
    ],
    [
      'point 9 tracker-write approve (ru) is refused',
      { source: 'tracker-write', point: 9, options: ['Разрешить комментарий', 'Не писать'] },
      'Разрешить комментарий',
      false,
    ],
    [
      'point 9 tracker-write approve (en) is refused',
      { source: 'tracker-write', point: 9, options: ['Allow the comment', 'Do not write'] },
      'Allow the comment',
      false,
    ],
    [
      'point 9 tracker-write decline passes',
      { source: 'tracker-write', point: 9, options: ['Разрешить комментарий', 'Не писать'] },
      'Не писать',
      true,
    ],
    [
      'ask_human free text passes',
      { source: 'ask_human', point: 6 },
      'use the second approach',
      true,
    ],
    ['blocker free text passes', { source: 'blocker', point: 6 }, 'skip it', true],
    ['scenario-step free text passes', { source: 'scenario-step', point: 8 }, 'looks fine', true],
    [
      'budget option passes',
      { source: 'budget', point: 7, options: ['Extend the limit', 'Stop the step'] },
      'Stop the step',
      true,
    ],
    [
      'budget free text is refused',
      { source: 'budget', point: 7, options: ['Extend the limit', 'Stop the step'] },
      'whatever',
      false,
    ],
    [
      'point 7 model switch option passes',
      { source: 'budget', point: 7, options: ['wait', 'model:opus'] },
      'model:opus',
      true,
    ],
    [
      'intake option outside the list is refused',
      { source: 'intake', point: 2, options: ['a', 'b'] },
      'c',
      false,
    ],
  ] as const)('%s', (_name, over, text, ok) => {
    expect(judgeTelegramScope(answer(text), ask(over as Partial<AskEntry>)).ok).toBe(ok);
  });

  it('an answer to an ask that is not open (answered, expired, withdrawn) or unknown is refused', () => {
    for (const state of ['answered', 'expired', 'withdrawn'] as const) {
      expect(judgeTelegramScope(answer('x'), ask({ state })).ok).toBe(false);
    }
    expect(judgeTelegramScope(answer('x'), {}).ok).toBe(false);
  });

  it('approve-split only for the split its open launch ask names', () => {
    const asks = ask({ source: 'launch', point: 10, dedupe: 'split:S1' });
    const approve = (splitId: string) => ({ kind: 'approve-split' as const, fields: { splitId } });
    expect(judgeTelegramScope(approve('S1'), asks).ok).toBe(true);
    expect(judgeTelegramScope(approve('S2'), asks).ok).toBe(false);
    expect(
      judgeTelegramScope(
        approve('S1'),
        ask({ source: 'launch', point: 10, dedupe: 'split:S1', state: 'answered' }),
      ).ok,
    ).toBe(false);
  });

  it('board-move to work only; steering kinds pass; any other kind is refused', () => {
    expect(judgeTelegramScope({ kind: 'board-move', fields: { to: 'work' } }, {}).ok).toBe(true);
    expect(judgeTelegramScope({ kind: 'board-move', fields: { to: 'merge' } }, {}).ok).toBe(false);
    expect(judgeTelegramScope({ kind: 'board-move', fields: { entries: [] } }, {}).ok).toBe(false);
    for (const kind of ['cancel', 'rework', 'set-model', 'set-cli'] as const) {
      expect(judgeTelegramScope({ kind, fields: {} }, {}).ok).toBe(true);
    }
    for (const kind of ['grant', 'set-config', 'take-over', 'publish-now'] as const) {
      expect(judgeTelegramScope({ kind, fields: {} }, {}).ok).toBe(false);
    }
  });

  it('inbox-create only as a Telegram hand entry; search entries and a missing source are refused', () => {
    const create = (fields: unknown) => judgeTelegramScope({ kind: 'inbox-create', fields }, {});
    expect(create({ source: 'telegram', text: 'fix login', key: 'tg:2:41' }).ok).toBe(true);
    expect(create({ source: 'search', sourceId: 'jira-main', items: [] }).ok).toBe(false);
    expect(create({}).ok).toBe(false);
    expect(create(undefined).ok).toBe(false);
  });
});
