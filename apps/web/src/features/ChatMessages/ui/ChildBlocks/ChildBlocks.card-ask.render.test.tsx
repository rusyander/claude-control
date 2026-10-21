import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import { cardQuestions } from '../../lib/cardQuestions';
import type { ChildQuestion } from '../ChildQuestion.types';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildBlocks } from './ChildBlocks';
import { splitGroupKey } from '../../lib/splitGroupKey';

/**
 * Карточки 4 и 27 прогона 20.10: группа 3 спросила посреди хода, узел оставался
 * «работает», а в её карточке хаба вопроса не было — он стоял полосой над всем
 * хабом, без стадии и чата. Вопрос разговора с карточкой живёт в карточке,
 * островком «Агент спрашивает · стадия · чат»; вопрос чата без карточки — в
 * полосе, как раньше.
 */

type Group = SplitPlanView['groups'][number];

const group = (index: number, chatId: string): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'started',
  chatId,
});

const ask = (chatId: string, question: string, isRunning = true): ChildQuestion => ({
  chatId,
  title: `чат ${chatId}`,
  toolUseId: `tu-${chatId}`,
  isRunning,
  input: JSON.stringify({
    questions: [
      {
        question,
        header: 'Выбор',
        multiSelect: false,
        options: [
          { label: 'Да', description: 'так' },
          { label: 'Нет', description: 'иначе' },
        ],
      },
    ],
  }),
});

const GROUP_CHAT = '3f9a1c2e-7b44-4d0e-9a51-0c6d2b1e8f10';

function stagesOf(groups: Group[]): ChildStageGroup[] {
  const rows = new Map<string, ChildStageGroup>(
    groups.map((item) => [
      splitGroupKey({ groupIndex: item.index, id: '' }),
      {
        chatId: item.chatId ?? '',
        title: item.title,
        stages: ['plan', 'work'],
        isRunning: true,
      },
    ]),
  );
  return mergeSplitGroups(rows, {
    parentChatId: 'parent',
    triage: { at: '2026-10-20T19:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: groups.map((item) => item.index),
    groups,
  });
}

function render(questions: ChildQuestion[], answerable = true): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildBlocks
        stages={stagesOf([group(0, 'c0'), group(3, GROUP_CHAT)])}
        onOpenChild={() => {}}
        questions={questions}
        {...(answerable ? { onAnswer: () => {} } : {})}
      />
    </QueryClientProvider>,
  );
}

/** Разметка карточки группы, в которой стоит текст. */
function cardWith(html: string, text: string): string {
  const at = html.indexOf(text);
  const start = html.lastIndexOf('data-hub-row', at);
  const next = html.indexOf('data-hub-row', at);
  return html.slice(start, next < 0 ? undefined : next);
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('вопрос агента группы — в её карточке', () => {
  it('вопрос посреди хода стоит островком в карточке своей группы, полосы нет', () => {
    const html = render([ask(GROUP_CHAT, 'Как подписать запись журнала шлюза?')]);
    expect(html).not.toContain('data-child-asks');
    expect(html).toContain('data-group-ask="1"');
    const card = cardWith(html, 'Как подписать запись журнала шлюза?');
    expect(card).toContain('Группа 3');
    expect(card).not.toContain('Группа 0');
    expect(card).toContain('Агент спрашивает · работа · чат 3f9a1c2e');
    expect(card).toContain(`title="${GROUP_CHAT}"`);
    expect(html.indexOf('data-group-ask')).toBeGreaterThan(html.indexOf('data-child-hub'));
  });

  it('вопрос чата без карточки остаётся в полосе над хабом', () => {
    const html = render([ask('manual-9', 'Какой формат выгрузки?')]);
    expect(html).toContain('data-child-asks');
    expect(html).not.toContain('data-group-ask');
    expect(html).toContain('Спрашивает «чат manual-9»');
    expect(html.indexOf('Какой формат выгрузки?')).toBeLessThan(html.indexOf('data-child-hub'));
  });

  it('без обработчика ответа вопроса нет ни в карточке, ни в полосе', () => {
    const html = render([ask(GROUP_CHAT, 'Скрытый вопрос')], false);
    expect(html).not.toContain('data-group-ask');
    expect(html).not.toContain('data-child-asks');
    expect(html).not.toContain('Скрытый вопрос');
  });
});

describe('cardQuestions — чей вопрос куда', () => {
  it('по ключу карточки — в карточку, прочие — в полосу, неразборчивые — никуда', () => {
    const groups = stagesOf([group(0, 'c0'), group(3, GROUP_CHAT)]);
    const broken: ChildQuestion = { chatId: 'c0', title: 'чат c0', input: '{oops' };
    const text: ChildQuestion = { chatId: 'c0', title: 'чат c0', input: '', text: 'Куда дальше?' };
    const { inCards, strip } = cardQuestions(groups, [
      ask(GROUP_CHAT, 'один'),
      ask('manual-9', 'два'),
      broken,
      text,
    ]);
    expect([...inCards.keys()]).toEqual([GROUP_CHAT, 'c0']);
    expect(inCards.get('c0')).toEqual([text]);
    expect(strip.map((item) => item.chatId)).toEqual(['manual-9']);
  });

  it('карточка снятой группы вопрос не забирает', () => {
    const groups = stagesOf([group(3, GROUP_CHAT)]).map((item) => ({ ...item, retired: true }));
    const { inCards, strip } = cardQuestions(groups, [ask(GROUP_CHAT, 'один')]);
    expect(inCards.size).toBe(0);
    expect(strip).toHaveLength(1);
  });
});
