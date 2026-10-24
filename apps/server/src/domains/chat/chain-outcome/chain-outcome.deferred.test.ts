import { describe, it, expect } from 'vitest';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { awaitsAnswer } from '../group-questions/group-wait.ts';
import { chainOutcomeOf } from './chain-outcome.ts';

/**
 * Конец хода, где остались только D-n (решение 6): законное ожидание решения
 * человека списком. Не вопрос (панель за человека не отвечает, «решай сам» не
 * тратится), не «готово» (ждавшие группу не стартуют от недоделанной ветки).
 */

const WORK: ChatLink = {
  parentChatId: 'p',
  groupIndex: 0,
  createdAt: '',
  branch: 'b',
  stage: 'work',
};

const DEFERRED_ONLY =
  'Stage A is done and pushed; the draft MR is open.\n\n' +
  'Waiting for the human: D-7 — dropping the stale users table unblocks the cleanup step\n' +
  'Waiting for the human: D-8 — deleting the old release branch';

describe('итог хода с одними D-n', () => {
  it('ждут D-n группы — `human-op`, хвост называет номер', () => {
    const outcome = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: DEFERRED_ONLY,
      deferred: ['D-7', 'D-8'],
      hasWork: () => true,
    });
    expect(outcome.status).toBe('awaiting');
    expect(outcome.waitingFor).toBe('human-op');
    expect(outcome.tail).toContain('D-8');
  });

  it('D-n уже решены (ничего не ждёт) — обычный итог по фактам копии', () => {
    const outcome = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: DEFERRED_ONLY,
      hasWork: () => true,
    });
    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'changed' } });
  });

  it('настоящий вопрос рядом с D-n — вопрос: его панель видит и отвечает', () => {
    const outcome = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: `${DEFERRED_ONLY}\n\nWhich schema should stage B use?`,
      deferred: ['D-7'],
    });
    expect(outcome.waitingFor).toBe('question');
  });

  it('строки D-n на русском — тоже ожидание решения, а не вопрос', () => {
    const outcome = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: 'Сделал этап A.\n\nЖдёт решения человека: D-3 — удалить старую ветку',
      deferred: ['D-3'],
    });
    expect(outcome.waitingFor).toBe('human-op');
  });

  // Строка D-n, написанная вопросом, — всё равно ожидание решения списком:
  // без вычета строк D-n её «?» в конце сделал бы ход вопросом, и панель
  // ответила бы за человека (mustfail 23.10: мутант без вычета выживал).
  it('строка D-n вопросом в конце — ожидание решения, не вопрос', () => {
    const outcome = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: 'Stage A is done.\n\nWaiting for the human: D-9 — may I drop the stale users table?',
      deferred: ['D-9'],
    });
    expect(outcome.waitingFor).toBe('human-op');
  });
});

describe('«решай сам» и R27 на одних D-n не срабатывают', () => {
  it('ответ из строк D-n — не ожидание ответа текстом', () => {
    expect(awaitsAnswer(DEFERRED_ONLY)).toBe(false);
  });

  it('строка D-n с «need your decision» и «?» — не ожидание ответа текстом', () => {
    expect(
      awaitsAnswer(
        'Stage A is done.\n\nWaiting for the human: D-9 — need your decision: drop the stale users table?',
      ),
    ).toBe(false);
  });

  it('вопрос текстом рядом с D-n — по-прежнему ожидание ответа', () => {
    expect(awaitsAnswer(`${DEFERRED_ONLY}\n\nI will start stage B after your answer.`)).toBe(true);
  });
});
