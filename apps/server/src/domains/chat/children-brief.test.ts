import { describe, expect, it } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { childrenBrief, stripChildrenBrief, withChildrenBrief } from './children-brief.ts';
import { cleanText, toBlocks } from './ChatRecords.ts';

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
    expect(brief).toContain('Сам её не делай');
    expect(brief).toContain(
      '1. «Ревью MR» (ветка feature/mr, копия C:/work/p-mr, чат review-1) — закончила; ' +
        'только проверка, правок не было.',
    );
    expect(brief).toContain(
      '2. «Шапка» (ветка feature/header, чат work-2) — ждёт человека; задала вопрос и ждёт ' +
        'ответа. Последний ответ: «Липкой делать и на мобильном?»',
    );
    expect(brief).toContain(
      '3. «Тесты» (ветка feature/tests, чата ещё нет) — сбой: копия не завелась.',
    );
  });

  it('сдавшаяся после повторов группа — с числом повторов панели (Д10)', () => {
    const [, , third] = SPLIT.groups;
    const brief = childrenBrief({ ...SPLIT, groups: [{ ...third!, retries: 3 }] }) ?? '';

    expect(brief).toContain('— сбой: копия не завелась (панель повторяла ход: 3).');
  });

  it('разделения нет — сводки нет', () => {
    expect(childrenBrief(undefined)).toBeUndefined();
    expect(childrenBrief({ ...SPLIT, groups: [] })).toBeUndefined();
  });

  it('длинный хвост ответа режется с начала: вопрос обычно в конце', () => {
    const tail = `${'а'.repeat(500)} Что делать?`;
    const brief = childrenBrief({ ...SPLIT, groups: [{ ...SPLIT.groups[1]!, tail }] }) ?? '';

    expect(brief).toContain('Что делать?»');
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
});

describe('сводка и команды CLI', () => {
  // «Сжать контекст» в карточке переполнения шлёт `/compact`: сводка перед ней
  // превратила бы команду родителя разделения в обычный текст.
  it('команда CLI идёт без сводки, обычная реплика — со сводкой', () => {
    expect(withChildrenBrief('/compact', 'СВОДКА')).toBe('/compact');
    expect(withChildrenBrief('Как дела у групп?', 'СВОДКА')).toBe('СВОДКА\n\nКак дела у групп?');
  });
});
