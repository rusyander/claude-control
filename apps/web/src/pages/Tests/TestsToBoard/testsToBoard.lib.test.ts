import { describe, expect, it } from 'vitest';
import {
  boardEntryDraftSchema,
  type BoardCard,
  type BoardColumn,
} from '@agentdeck/contracts/core/board';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import { coreInboxRu } from '@shared/config/i18n/core-inbox/ru';
import {
  caseOnBoard,
  testsEntryDraft,
  testsRequestOf,
  type TestsEntryInput,
} from './testsToBoard.lib';

/** Подстановка `{{name}}` по текстам `coreInbox.tests` — как i18next, без него. */
const t = (key: string, values: Record<string, string | number> = {}) =>
  (coreInboxRu.tests as Record<string, string>)[key]!.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(values[name] ?? ''),
  );

const input: TestsEntryInput = {
  projectPath: 'C:/work/demo',
  runId: 'run-inbox-1',
  title: 'Кнопка сохранения',
  lang: 'ru',
  result: {
    groupId: 'gui',
    caseId: 'gui-001',
    note: 'снимок приложен',
    params: { browser: 'chromium' },
    failure: { step: 2, expected: 'кнопка активна', actual: 'кнопка выключена' },
  },
};

describe('tests to board', () => {
  it('red case becomes a bug-fix inbox entry keyed by group/case, valid by the contract', () => {
    const draft = testsEntryDraft(input, t);
    expect(boardEntryDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.preset).toBe('bug-fix');
    expect(draft.source).toEqual({
      kind: 'tests',
      key: 'gui/gui-001',
      title: 'Тест падает: Кнопка сохранения',
    });
    expect(draft.launch).toMatchObject({
      kind: 'fields',
      fields: { repos: [{ path: 'C:/work/demo', baseRef: null }], lang: 'ru' },
    });
  });

  it('request carries the failure analysis from the run record', () => {
    const text = testsRequestOf(input, t);
    expect(text.split('\n')).toEqual([
      'Кейс gui/gui-001 «Кнопка сохранения» падает в прогоне run-inbox-1.',
      'Шаг: 2.',
      'Ожидалось: кнопка активна',
      'Вышло: кнопка выключена',
      'Заметка прогона: снимок приложен',
      'Параметры: browser=chromium',
      coreInboxRu.tests.goal,
    ]);
  });

  it('a bare failure still names case, run and goal', () => {
    const text = testsRequestOf({ ...input, result: { groupId: 'g', caseId: 'c' } }, t);
    expect(text.split('\n')).toHaveLength(2);
  });

  it('a huge failure text still fits the estimate request the core starts the entry with', () => {
    const huge = 'стек '.repeat(20_000);
    const draft = testsEntryDraft(
      {
        ...input,
        result: { ...input.result, note: huge, failure: { expected: huge, actual: huge } },
      },
      t,
    );
    const fields = draft.launch.kind === 'fields' ? draft.launch.fields : {};
    expect(estimateFieldsSchema.shape.request.safeParse(fields.request).success).toBe(true);
    const request = String(fields.request);
    expect(request).toContain('Вышло: стек');
    expect(request.endsWith(coreInboxRu.tests.goal)).toBe(true);
  });
});

describe('tests to board: already on the board', () => {
  const card = (
    column: BoardColumn,
    key = 'gui/gui-001',
  ): Pick<BoardCard, 'column' | 'source'> => ({
    column,
    source: { kind: 'tests', key, title: 'Тест падает: Кнопка сохранения' },
  });

  it('an open card of this case keeps the button «На доске»: the core does not merge entries by case', () => {
    expect(caseOnBoard([card('inbox')], 'gui/gui-001')).toBe(true);
    expect(caseOnBoard([card('work')], 'gui/gui-001')).toBe(true);
  });

  it('a closed or merged card, another case or another source kind does not block a new entry', () => {
    expect(caseOnBoard([card('closed'), card('merged')], 'gui/gui-001')).toBe(false);
    expect(caseOnBoard([card('inbox', 'gui/gui-002')], 'gui/gui-001')).toBe(false);
    expect(
      caseOnBoard(
        [{ column: 'inbox', source: { kind: 'tracker', key: 'gui/gui-001', title: 'x' } }],
        'gui/gui-001',
      ),
    ).toBe(false);
    expect(caseOnBoard(undefined, 'gui/gui-001')).toBe(false);
  });
});
