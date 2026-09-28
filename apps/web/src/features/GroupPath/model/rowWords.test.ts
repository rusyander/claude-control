import { describe, expect, it } from 'vitest';
import type { GroupMembersView } from '@agentdeck/contracts';
import type { PathRow } from './pathRows';
import { rowWords, type WordsSource } from './rowWords';

const row = (title: string): PathRow => ({
  kind: 'entry',
  key: 'k',
  entryIndex: 1,
  knobs: [],
  entry: { kind: 'skill-step', skillId: 'ticket-delivery', index: 0, title },
});

const view = (over: Partial<GroupMembersView> = {}): GroupMembersView => ({
  groupId: 'g',
  members: [],
  steps: [],
  ...over,
});

const source = (language: string, v: GroupMembersView, section: string): WordsSource => ({
  language,
  view: v,
  stageTitle: (stage) => stage,
  stageHint: () => '',
  wholeTitle: (id) => id,
  pendingStepTitle: (number) => `Шаг ${number} скилла`,
  notDescribedLine: 'описать шаг не вышло',
  sectionText: () => section,
});

const EN_SECTION = 'Every comment read, the defect located in code.';

describe('rowWords: шаг скилла без описания в русском интерфейсе', () => {
  it('описать не вышло — номер шага и слова интерфейса, а не английский раздел', () => {
    const words = rowWords(row('Read the task'), source('ru', view(), EN_SECTION));
    expect(words.title).toBe('Шаг 1 скилла');
    expect(words.line).toBe('описать шаг не вышло');
    expect(words.hint).not.toContain('Every comment');
    expect(words.isDescribing).toBe(false);
  });

  it('пока описывается — номер шага и «готовится»', () => {
    const pending = view({ pending: ['step:ticket-delivery'] });
    const words = rowWords(row('Read the task'), source('ru', pending, EN_SECTION));
    expect(words.title).toBe('Шаг 1 скилла');
    expect(words.line).toBe('');
    expect(words.isDescribing).toBe(true);
  });

  it('скилл на русском идёт как есть — это язык человека', () => {
    const words = rowWords(row('Прочитать задачу'), source('ru', view(), 'Все комментарии.'));
    expect(words.title).toBe('Прочитать задачу');
    expect(words.line).toBe('Все комментарии.');
  });

  it('в английском интерфейсе — оригинал раздела', () => {
    const words = rowWords(row('Read the task'), source('en', view(), EN_SECTION));
    expect(words.title).toBe('Read the task');
    expect(words.line).toBe(EN_SECTION);
  });
});
