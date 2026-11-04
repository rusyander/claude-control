import { describe, it, expect } from 'vitest';
import {
  AUTONOMOUS_PICK_MARKER,
  autonomousPickMessage,
  parseAutonomousPickMessage,
} from '@agentdeck/contracts/chat-group-settings';
import type { ChatBlock } from '@agentdeck/contracts';
import {
  attachAutoPicks,
  autoPickResults,
  picksFor,
  recommendedPicks,
  rememberAsks,
  toolResultText,
  type AskSeen,
} from './auto-pick.ts';

const ask = (...questions: { question?: unknown; header?: string; options?: unknown }[]) => ({
  questions,
});

describe('recommendedPicks — что автономия выбирает сама', () => {
  it('«(Recommended)» в подписи, в любом месте списка', () => {
    expect(
      recommendedPicks(
        ask({ question: 'Q', options: [{ label: 'A' }, { label: 'B (Recommended)' }] }),
      ),
    ).toEqual([{ question: 'Q', label: 'B (Recommended)', critical: false }]);
  });

  it('рекомендация по-русски и в описании', () => {
    expect(
      recommendedPicks(
        ask(
          { question: 'Q1', options: [{ label: 'A' }, { label: 'B (рекомендую)' }] },
          {
            question: 'Q2',
            header: 'critical',
            options: [{ label: 'X' }, { label: 'Y', description: 'Recommended: smaller diff' }],
          },
        ),
      ),
    ).toEqual([
      { question: 'Q1', label: 'B (рекомендую)', critical: false },
      { question: 'Q2', label: 'Y', critical: true },
    ]);
  });

  it('без рекомендации хоть у одного вопроса — весь вызов человеку', () => {
    expect(
      recommendedPicks(
        ask(
          { question: 'Q1', options: [{ label: 'A (Recommended)' }] },
          { question: 'Q2', options: [{ label: 'A' }, { label: 'B' }] },
        ),
      ),
    ).toBeNull();
  });

  it('отрицание — не рекомендация', () => {
    expect(
      recommendedPicks(
        ask({ question: 'Q', options: [{ label: 'A', description: "we don't recommend this" }] }),
      ),
    ).toBeNull();
  });

  it('рекомендованный вариант зовёт человека или утверждает сделанное им — человеку', () => {
    for (const label of [
      'Я войду сам (Recommended)',
      'Session refreshed — continue (Recommended)',
    ]) {
      expect(
        recommendedPicks(
          ask({ question: 'Q', options: [{ label }, { label: 'Skip live check' }] }),
        ),
      ).toBeNull();
    }
  });

  it('мусор на входе — null, не исключение', () => {
    for (const input of [
      null,
      undefined,
      {},
      { questions: [] },
      ask({ options: [] }),
      ask(null as never),
    ])
      expect(recommendedPicks(input)).toBeNull();
  });
});

/**
 * Автовыбор узнаётся по результату вызова — одному на оба пути (хук и брокер).
 * Проверяем: метка находит результат строкой и списком блоков, обычный отказ
 * автовыбором не считается, `critical` берётся из тела вопроса, а без тела —
 * разбором текста и без критичности.
 */
const INPUT = {
  questions: [
    {
      question: 'Какой путь?',
      header: 'critical',
      options: [{ label: 'Быстрый' }, { label: 'Надёжный (Recommended)' }],
    },
  ],
};
const MESSAGE = autonomousPickMessage([
  { question: 'Какой путь?', label: 'Надёжный (Recommended)', critical: true },
]);

describe('автовыбор по результату вызова', () => {
  it('текст результата — строкой и списком текстовых блоков', () => {
    expect(toolResultText('a')).toBe('a');
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }])).toBe(
      'a\n\nb',
    );
    expect(toolResultText(undefined)).toBe('');
  });

  it('результат с меткой узнаётся, обычный отказ — нет', () => {
    const found = autoPickResults([
      { type: 'tool_result', tool_use_id: 'q1', content: MESSAGE },
      { type: 'tool_result', tool_use_id: 'q2', content: 'User declined' },
      { type: 'tool_result', content: MESSAGE },
      { type: 'text', text: AUTONOMOUS_PICK_MARKER },
    ]);
    expect(found.map((item) => item.toolUseId)).toEqual(['q1']);
    expect(autoPickResults('строка')).toEqual([]);
  });

  it('тело известно — критичность из заголовка вопроса', () => {
    expect(picksFor(INPUT, MESSAGE)).toEqual([
      { question: 'Какой путь?', label: 'Надёжный (Recommended)', critical: true },
    ]);
  });

  it('тела нет — разбор текста, критичность неизвестна', () => {
    expect(picksFor(undefined, MESSAGE)).toEqual([
      { question: 'Какой путь?', label: 'Надёжный (Recommended)', critical: false },
    ]);
  });

  it('транскрипт: выбор ложится на блок своего вопроса по id', () => {
    const asks = new Map<string, AskSeen>();
    const blocks: ChatBlock[] = [
      { type: 'tool', name: 'Read', input: '{}' },
      { type: 'tool', name: 'AskUserQuestion', input: JSON.stringify(INPUT) },
    ];
    rememberAsks(
      asks,
      [
        { type: 'tool_use', id: 'r1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: INPUT },
      ],
      blocks,
    );
    attachAutoPicks(asks, [{ type: 'tool_result', tool_use_id: 'q1', content: MESSAGE }]);
    expect(blocks[1]).toMatchObject({
      autoPicks: [{ question: 'Какой путь?', label: 'Надёжный (Recommended)' }],
    });
    expect(blocks[0]).not.toHaveProperty('autoPicks');
    expect(asks.size).toBe(0);
  });
});

/**
 * Ревью 28.09 (F-132): текст отказа — единственное, что знает прогон, не видевший
 * самого вызова (переподключение посреди хода). Вопрос с переводом строки
 * писался как есть, разбор шёл построчно — и выбор терялся, `picks: []`.
 */
describe('отказ автовыбора разбирается обратно без потерь', () => {
  const tricky = {
    questions: [
      {
        question: 'Какой вариант?\nУчти "кавычки" и → стрелку',
        options: [{ label: 'Быстрый' }, { label: 'A → B (Recommended)' }],
      },
      { question: 'Второй?', options: [{ label: 'Да (Recommended)' }] },
    ],
  };

  it('вопрос с переводом строки, кавычками и стрелкой — тот же выбор', () => {
    const picks = recommendedPicks(tricky)!;
    expect(parseAutonomousPickMessage(autonomousPickMessage(picks))).toEqual(
      picks.map(({ question, label }) => ({ question, label })),
    );
    expect(picksFor(undefined, autonomousPickMessage(picks))).toHaveLength(2);
  });

  it('текст прежнего вида (уже в транскриптах, пишет его и хук) по-прежнему читается', () => {
    const old = [
      `${AUTONOMOUS_PICK_MARKER}: autonomous.`,
      '- "Путь "быстрый"?" → Надёжный (Recommended)',
      '- "C:\\dir?" → Да',
    ].join('\n');
    expect(parseAutonomousPickMessage(old)).toEqual([
      { question: 'Путь "быстрый"?', label: 'Надёжный (Recommended)' },
      { question: 'C:\\dir?', label: 'Да' },
    ]);
  });
});
