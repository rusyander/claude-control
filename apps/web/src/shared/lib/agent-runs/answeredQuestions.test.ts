import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Память об отвеченных вопросах.
 *
 * Регрессия из аудита: «отправлено» жило в состоянии карточки. Ответил ребёнку,
 * ушёл на другую вкладку, вернулся — карточка смонтирована заново и снова
 * выглядит неотвеченной, а источник вопроса продолжает его отдавать. Второй
 * ответ на тот же вопрос — это второй ход агента.
 */

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
  };
}

/** Свежая вкладка: модуль-синглтон без памяти о прошлой жизни. */
async function reload(): Promise<typeof import('./answered-questions')> {
  vi.resetModules();
  return await import('./answered-questions');
}

describe('память отвеченных вопросов', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('отвеченный вопрос помнится и не воскресает после перезагрузки', async () => {
    const first = await reload();
    first.markQuestionAnswered('чат-1#tool-77');
    expect(first.getAnsweredQuestions().has('чат-1#tool-77')).toBe(true);

    const second = await reload();
    expect(second.getAnsweredQuestions().has('чат-1#tool-77')).toBe(true);
  });

  it('снимок меняет ссылку при новой отметке — иначе подписчики не перерисуются', async () => {
    const store = await reload();
    const before = store.getAnsweredQuestions();
    store.markQuestionAnswered('чат-2#tool-1');
    expect(store.getAnsweredQuestions()).not.toBe(before);
  });

  it('повторная отметка того же вопроса ничего не меняет', async () => {
    const store = await reload();
    store.markQuestionAnswered('чат-3#tool-1');
    const after = store.getAnsweredQuestions();
    store.markQuestionAnswered('чат-3#tool-1');
    expect(store.getAnsweredQuestions()).toBe(after);
  });

  it('пустой ключ не запоминается: безымянный вопрос погасил бы все остальные', async () => {
    const store = await reload();
    store.markQuestionAnswered(undefined);
    store.markQuestionAnswered('');
    expect(store.getAnsweredQuestions().size).toBe(0);
  });

  it('список не растёт без конца — самые старые отметки вытесняются', async () => {
    const store = await reload();
    for (let i = 0; i < 250; i += 1) store.markQuestionAnswered(`чат#${i}`);

    const known = store.getAnsweredQuestions();
    expect(known.size).toBe(200);
    expect(known.has('чат#0')).toBe(false);
    expect(known.has('чат#249')).toBe(true);
  });
});
