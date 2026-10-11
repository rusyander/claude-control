import { describe, it, expect } from 'vitest';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { isRelayCard, relayDecisions } from './relayAnswers';

/**
 * Ответ сессии вне панели уходит хуку как `answers` вопроса Claude Code:
 * ключ — ТЕКСТ вопроса. Перепутанный ключ CLI молча не примет.
 */

const ask = (
  index: number,
  over: Partial<Extract<InboxAsk, { kind: 'question' }>> = {},
): InboxAsk => ({
  kind: 'question',
  key: `q:t1:${index}`,
  toolUseId: 't1',
  index,
  total: 2,
  question: { question: `Вопрос ${index}?`, options: [{ label: 'A' }, { label: 'B' }] },
  askedAt: '2026-10-11T12:00:00.000Z',
  relay: true,
  ...over,
});

describe('relayDecisions', () => {
  it('все вопросы отвечены — текст вопроса → выбор, несколько через запятую', () => {
    const state = {
      answers: {
        'q:t1:0': { kind: 'question' as const, labels: ['A'] },
        'q:t1:1': { kind: 'question' as const, labels: ['A', 'свой ответ'] },
      },
    };
    expect(relayDecisions([ask(0), ask(1)], state)).toEqual([
      {
        toolUseId: 't1',
        body: { answers: { 'Вопрос 0?': 'A', 'Вопрос 1?': 'A, свой ответ' } },
        keys: ['q:t1:0', 'q:t1:1'],
      },
    ]);
  });

  it('не всё отвечено — ответа нет', () => {
    const state = { answers: { 'q:t1:0': { kind: 'question' as const, labels: ['A'] } } };
    expect(relayDecisions([ask(0), ask(1)], state)).toBeUndefined();
  });

  it('вопрос не держит хук — ответа нет, вопросы разных вызовов — порознь', () => {
    const state = {
      answers: {
        'q:t1:0': { kind: 'question' as const, labels: ['A'] },
        'q:t1:1': { kind: 'question' as const, labels: ['B'] },
      },
    };
    expect(relayDecisions([ask(0), ask(1, { relay: false })], state)).toBeUndefined();
    // Два вызова — два ответа: каждый хук получает только свои вопросы.
    expect(
      relayDecisions([ask(0), ask(1, { toolUseId: 't2' })], state)?.map((item) => item.toolUseId),
    ).toEqual(['t1', 't2']);
  });

  it('запрос прав — «разрешить / запретить» своему вызову, вместе с вопросом', () => {
    const bash: InboxAsk = {
      kind: 'permission',
      key: 'r:b1',
      toolUseId: 'b1',
      toolName: 'Bash',
      input: { command: 'ls' },
      askedAt: '2026-10-11T12:00:00.000Z',
      relay: true,
    };
    const state = {
      answers: {
        'r:b1': { kind: 'permission' as const, behavior: 'deny' as const },
        'q:t1:0': { kind: 'question' as const, labels: ['B'] },
      },
    };
    expect(relayDecisions([bash, ask(0, { total: 1 })], state)).toEqual([
      { toolUseId: 'b1', body: { behavior: 'deny' }, keys: ['r:b1'] },
      { toolUseId: 't1', body: { answers: { 'Вопрос 0?': 'B' } }, keys: ['q:t1:0'] },
    ]);
    // Права не решены — не уходит ничего: карточка отправляется целиком.
    expect(relayDecisions([bash], { answers: {} })).toBeUndefined();
    // Запрос прав своего прогона панели (без relay) — не через хук.
    expect(isRelayCard([{ ...bash, relay: undefined }])).toBe(false);
  });

  it('карточка через хук — только когда хук держит все её вопросы', () => {
    expect(isRelayCard([ask(0), ask(1)])).toBe(true);
    expect(isRelayCard([ask(0), ask(1, { relay: undefined })])).toBe(false);
    expect(isRelayCard([])).toBe(false);
  });
});
