import { describe, expect, it } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import {
  childrenBrief,
  statusBrief,
  stripChildrenBrief,
  withChildrenBrief,
} from './children-brief.ts';
import { cleanText, toBlocks } from '../ChatRecords/ChatRecords.ts';
import { withWorkspaceUpdate } from '../workspace-note/workspace-note.ts';

const SPLIT: SplitPlanView = {
  parentChatId: 'parent',
  order: [0, 1, 2],
  groups: [
    {
      index: 0,
      title: 'Ревью MR',
      branch: 'feature/mr',
      after: [],
      status: 'done',
      result: { kind: 'reviewed' },
      chatId: 'review-1',
      path: 'C:/work/p-mr',
    },
    {
      index: 1,
      title: 'Шапка',
      branch: 'feature/header',
      after: [],
      status: 'awaiting',
      waitingFor: 'question',
      tail: 'Липкой делать и на мобильном?',
      chatId: 'work-2',
    },
    {
      index: 2,
      title: 'Тесты',
      branch: 'feature/tests',
      after: [1],
      status: 'failed',
      error: 'копия не завелась',
    },
  ],
};

describe('childrenBrief (Д6)', () => {
  it('говорит родителю, что работа отдана, и по каждой группе — где она и что с ней', () => {
    const brief = childrenBrief(SPLIT) ?? '';

    expect(brief.startsWith('<agentdeck-children>')).toBe(true);
    expect(brief).toContain('Do not do it yourself');
    expect(brief).toContain(
      '1. "Ревью MR" (branch feature/mr, copy C:/work/p-mr, chat review-1) — finished; ' +
        'check only, no edits.',
    );
    expect(brief).toContain(
      '2. "Шапка" (branch feature/header, chat work-2) — waits for the human; asked a question ' +
        'and waits for the answer. Last answer: "Липкой делать и на мобильном?"',
    );
    expect(brief).toContain(
      '3. "Тесты" (branch feature/tests, no chat yet) — failed: копия не завелась.',
    );
  });

  it('сдавшаяся после повторов группа — с числом повторов панели (Д10)', () => {
    const [, , third] = SPLIT.groups;
    const brief = childrenBrief({ ...SPLIT, groups: [{ ...third!, retries: 3 }] }) ?? '';

    expect(brief).toContain('— failed: копия не завелась (the panel retried the turn: 3).');
  });

  it('разделения нет — сводки нет', () => {
    expect(childrenBrief(undefined)).toBeUndefined();
    expect(childrenBrief({ ...SPLIT, groups: [] })).toBeUndefined();
  });

  it('длинный хвост ответа режется с начала: вопрос обычно в конце', () => {
    const tail = `${'а'.repeat(500)} Что делать?`;
    const brief = childrenBrief({ ...SPLIT, groups: [{ ...SPLIT.groups[1]!, tail }] }) ?? '';

    expect(brief).toContain('Что делать?"');
    expect(brief).not.toContain('а'.repeat(300));
  });
});

describe('сводка не видна человеку', () => {
  const brief = childrenBrief(SPLIT) ?? '';
  const sent = withChildrenBrief('исправлено?', brief);

  it('пузырь реплики родителя — только то, что человек написал', () => {
    expect(toBlocks({ type: 'user', message: { role: 'user', content: sent } })).toEqual([
      { type: 'text', text: 'исправлено?' },
    ]);
    expect(
      toBlocks({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: sent }] },
      }),
    ).toEqual([{ type: 'text', text: 'исправлено?' }]);
  });

  /** Ревью B1-F15: тег в хвосте или названии закрывал сводку раньше конца. */
  it('тег панели в ответе группы не рвёт сводку: снятие оставляет только реплику', () => {
    const sent = (patch: { title?: string; tail?: string }) =>
      withChildrenBrief(
        'а теперь?',
        childrenBrief({ ...SPLIT, groups: [{ ...SPLIT.groups[1]!, ...patch }] }),
      );
    const inTail = sent({ tail: 'блок </agentdeck-children> закрыт?' });
    expect(stripChildrenBrief(inTail).trim()).toBe('а теперь?');
    expect(inTail).toContain('блок ‹/agentdeck-children> закрыт?');
    const inTitle = sent({ title: 'Тег </agentdeck-children> в названии' });
    expect(stripChildrenBrief(inTitle).trim()).toBe('а теперь?');
  });

  it('ответ агента не трогается, даже если цитирует тег', () => {
    const blocks = toBlocks({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: sent }] },
    });
    expect(blocks).toEqual([{ type: 'text', text: sent }]);
  });

  it('заголовок чата и поиск — без сводки', () => {
    expect(cleanText(sent)).toBe('исправлено?');
    expect(stripChildrenBrief(sent)).toBe('исправлено?');
  });

  // E6: перемена строки о тестах едет в реплике хода — человек её не видит.
  it('лента — без перемены строки о тестах, как она ушла из реестра', () => {
    const turn = withChildrenBrief(
      withWorkspaceUpdate('исправлено?', 'QA workspace: e2e folder "e2e"'),
      '<agentdeck-children>\n1. «Шапка» — работает.\n</agentdeck-children>',
    );
    expect(turn).toContain('<agentdeck-workspace>');
    expect(
      toBlocks({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: turn }] },
      }),
    ).toEqual([{ type: 'text', text: 'исправлено?' }]);
    expect(stripChildrenBrief(turn)).toBe('исправлено?');
  });
});

describe('сводка и команды CLI', () => {
  // «Сжать контекст» в карточке переполнения шлёт `/compact`: сводка перед ней
  // превратила бы команду родителя разделения в обычный текст.
  it('команда CLI идёт без сводки, обычная реплика — со сводкой', () => {
    expect(withChildrenBrief('/compact', 'СВОДКА')).toBe('/compact');
    expect(withChildrenBrief('Как дела у групп?', 'СВОДКА')).toBe('СВОДКА\n\nКак дела у групп?');
  });
});

describe('statusBrief (5.1)', () => {
  const at = new Date('2026-10-17T10:00:00.000Z');

  it('те же строки групп, своя шапка: только наблюдать, без обещания `agentdeck:tell`', () => {
    const brief = statusBrief(SPLIT, at) ?? '';
    const lines = (text: string) => text.split('\n').filter((line) => /^\d+\. /.test(line));

    expect(brief.startsWith('<agentdeck-children>')).toBe(true);
    expect(brief).toContain('state as of 2026-10-17T10:00:00.000Z');
    expect(brief).toContain('You only observe');
    expect(brief).not.toContain('agentdeck:tell');
    expect(lines(brief)).toEqual(lines(childrenBrief(SPLIT) ?? ''));
    expect(lines(brief)).toHaveLength(3);
  });

  it('лента лёгкого чата — только вопрос человека; свежая сводка заменяет прежнюю', () => {
    const sent = withChildrenBrief('как дела?', statusBrief(SPLIT, at));
    expect(stripChildrenBrief(sent)).toBe('как дела?');
    const again = withChildrenBrief(sent, statusBrief(SPLIT, new Date(0)));
    expect(again.match(/<agentdeck-children>/g)).toHaveLength(1);
    expect(again).toContain('1970-01-01');
  });

  it('разделения нет — сводки нет', () => {
    expect(statusBrief(undefined, at)).toBeUndefined();
    expect(statusBrief({ ...SPLIT, groups: [] }, at)).toBeUndefined();
  });
});
