import { describe, expect, it, vi } from 'vitest';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import {
  answerAsk,
  cardView,
  composeAnswer,
  editAsk,
  EMPTY_CARD,
  planSubmissions,
  reconcile,
  submitAll,
  type CardState,
} from './queue';

/**
 * Карточка вопросов одного чата на телефоне: по одному вопросу, ответ
 * сворачивает его и открывает следующий, после последнего — одна отправка.
 * Вопросы приходят и уходят между опросами сервера — это здесь и проверяется.
 */

const permission = (id: string, at = '2026-09-27T10:00:00.000Z'): InboxAsk => ({
  kind: 'permission',
  key: `p:${id}`,
  toolUseId: id,
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  askedAt: at,
});
const question = (index: number, total: number, multiSelect = false): InboxAsk => ({
  kind: 'question',
  key: `q:u1:${index}`,
  toolUseId: 'u1',
  index,
  total,
  question: {
    question: `Вопрос ${index + 1}?`,
    header: `Шаг ${index + 1}`,
    ...(multiSelect ? { multiSelect: true } : {}),
    options: [{ label: 'A' }, { label: 'B' }],
  },
  askedAt: '2026-09-27T10:01:00.000Z',
});

const asks = [permission('t1'), question(0, 2), question(1, 2, true)];

describe('карточка чата: один вопрос за раз', () => {
  it('сначала открыт первый, остальные ждут своей очереди', () => {
    const view = cardView(asks, EMPTY_CARD);
    expect(view.current?.key).toBe('p:t1');
    expect(view.upcoming.map((ask) => ask.key)).toEqual(['q:u1:0', 'q:u1:1']);
    expect(view.done).toEqual([]);
    expect(view).toMatchObject({ ready: false, step: 1, total: 3 });
  });

  it('ответ сворачивает вопрос и открывает следующий', () => {
    const state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    const view = cardView(asks, state);
    expect(view.done.map((item) => item.ask.key)).toEqual(['p:t1']);
    expect(view.current?.key).toBe('q:u1:0');
    expect(view.step).toBe(2);
  });

  it('после последнего ответа карточка готова к отправке', () => {
    let state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    state = answerAsk(state, 'q:u1:0', { kind: 'question', labels: ['A'] });
    state = answerAsk(state, 'q:u1:1', { kind: 'question', labels: ['A', 'свой ответ'] });
    const view = cardView(asks, state);
    expect(view.current).toBeUndefined();
    expect(view.ready).toBe(true);
    expect(view.done).toHaveLength(3);
  });

  it('«Изменить» возвращает к отвеченному, и отправка ждёт, пока не ответят снова', () => {
    let state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    state = answerAsk(state, 'q:u1:0', { kind: 'question', labels: ['A'] });
    state = answerAsk(state, 'q:u1:1', { kind: 'question', labels: ['B'] });
    state = editAsk(state, 'q:u1:0');
    expect(cardView(asks, state)).toMatchObject({ ready: false, step: 2 });
    expect(cardView(asks, state).current?.key).toBe('q:u1:0');
    state = answerAsk(state, 'q:u1:0', { kind: 'question', labels: ['B'] });
    expect(cardView(asks, state).ready).toBe(true);
  });

  it('«Изменить», пока ещё не всё отвечено, открывает выбранный, а не следующий по очереди', () => {
    let state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    state = editAsk(state, 'p:t1');
    const view = cardView(asks, state);
    expect(view.current?.key).toBe('p:t1');
    expect(view.upcoming.map((ask) => ask.key)).toEqual(['q:u1:0', 'q:u1:1']);
  });

  it('новый вопрос посреди ответа встаёт в конец и не перебивает текущий', () => {
    const state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    const grown = [...asks, permission('t2', '2026-09-27T10:05:00.000Z')];
    const view = cardView(grown, reconcile(state, grown));
    expect(view.current?.key).toBe('q:u1:0');
    expect(view.upcoming.map((ask) => ask.key)).toEqual(['q:u1:1', 'p:t2']);
    expect(view.total).toBe(4);
  });

  it('вопрос, снятый сервером посреди ответа, забывается; текущим становится следующий', () => {
    let state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    state = editAsk(state, 'p:t1');
    const shrunk = asks.slice(1);
    const next = reconcile(state, shrunk);
    expect(next.answers).toEqual({});
    expect(next.editing).toBeUndefined();
    expect(cardView(shrunk, next).current?.key).toBe('q:u1:0');
  });

  it('ничего не изменилось — тот же объект состояния (перерисовки нет)', () => {
    const state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'deny' });
    expect(reconcile(state, asks)).toBe(state);
  });
});

describe('ответ одним сообщением, как у панели', () => {
  const qs = [question(0, 2), question(1, 2)] as Extract<InboxAsk, { kind: 'question' }>[];

  it('один вопрос — просто выбранное', () => {
    const one = [question(0, 1)] as Extract<InboxAsk, { kind: 'question' }>[];
    expect(composeAnswer(one, { 'q:u1:0': { kind: 'question', labels: ['A', 'B'] } })).toBe('A, B');
  });

  it('несколько — строкой «заголовок: выбранное» на вопрос', () => {
    const answers: CardState['answers'] = {
      'q:u1:0': { kind: 'question', labels: ['A'] },
      'q:u1:1': { kind: 'question', labels: ['B', 'своё'] },
    };
    expect(composeAnswer(qs, answers)).toBe('Шаг 1: A\nШаг 2: B, своё');
  });
});

describe('отправка всей карточки', () => {
  const full = (): CardState => {
    let state = answerAsk(EMPTY_CARD, 'p:t1', { kind: 'permission', behavior: 'allow' });
    state = answerAsk(state, 'q:u1:0', { kind: 'question', labels: ['A'] });
    return answerAsk(state, 'q:u1:1', { kind: 'question', labels: ['B'] });
  };

  it('права — первыми и по ключу прогона, ответы на вопросы — одним сообщением', () => {
    expect(planSubmissions({ runKey: 'new-1' }, asks, full())).toEqual([
      { kind: 'permission', runKey: 'new-1', toolUseId: 't1', behavior: 'allow', keys: ['p:t1'] },
      { kind: 'message', text: 'Шаг 1: A\nШаг 2: B', keys: ['q:u1:0', 'q:u1:1'] },
    ]);
  });

  it('ворота ветки уходят своим маршрутом', async () => {
    const gate: InboxAsk = {
      kind: 'branchGate',
      key: 'g:g1',
      toolUseId: 'g1',
      toolName: 'Edit',
      input: {},
      askedAt: '2026-09-27T10:00:00.000Z',
    };
    const plan = planSubmissions({ runKey: 'k' }, [gate], {
      answers: { 'g:g1': { kind: 'branchGate', choice: 'here' } },
    });
    const post = vi.fn().mockResolvedValue({ ok: true });
    await submitAll(plan, { post, sendMessage: vi.fn() });
    expect(post).toHaveBeenCalledWith('/chat/k/branch-decision', {
      toolUseId: 'g1',
      choice: 'here',
    });
  });

  it('всё ушло — все ключи отправлены', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const outcome = await submitAll(planSubmissions({ runKey: 'new-1' }, asks, full()), {
      post,
      sendMessage,
    });
    expect(outcome).toEqual({ sentKeys: ['p:t1', 'q:u1:0', 'q:u1:1'] });
    expect(post).toHaveBeenCalledWith('/chat/new-1/permission-decision', {
      toolUseId: 't1',
      behavior: 'allow',
    });
    expect(sendMessage).toHaveBeenCalledWith('Шаг 1: A\nШаг 2: B');
  });

  it('сообщение не принято — права уже ушли и повторно не шлются, вопросы остаются', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, message: 'занято' });
    const outcome = await submitAll(planSubmissions({ runKey: 'new-1' }, asks, full()), {
      post,
      sendMessage,
    });
    expect(outcome).toEqual({ sentKeys: ['p:t1'], error: 'занято' });
  });

  it('сеть упала на правах — не ушло ничего, сообщение не отправлялось', async () => {
    const post = vi.fn().mockRejectedValue(new Error('нет сети'));
    const sendMessage = vi.fn();
    const outcome = await submitAll(planSubmissions({ runKey: 'new-1' }, asks, full()), {
      post,
      sendMessage,
    });
    expect(outcome).toEqual({ sentKeys: [], error: 'нет сети' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
