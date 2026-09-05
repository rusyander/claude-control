import { describe, it, expect } from 'vitest';
import { liveQuestionKey, questionKey } from './questionKey';

/**
 * Имя вопроса в памяти отвеченных. Требование к нему одно, зато жёсткое: два
 * разных вопроса обязаны получить разные имена. Совпади они — ответ на первый
 * погасил бы второй, и человек не смог бы ответить на вопрос, которого агент
 * ждёт прямо сейчас.
 */
describe('questionKey', () => {
  it('разные вызовы одного разговора — разные имена', () => {
    expect(questionKey('чат-1', 'tool-1')).not.toBe(questionKey('чат-1', 'tool-2'));
  });

  it('один и тот же вызов — одно и то же имя', () => {
    expect(questionKey('чат-1', 'tool-1')).toBe(questionKey('чат-1', 'tool-1'));
  });

  it('одинаковый вызов в разных разговорах — разные имена', () => {
    expect(questionKey('чат-1', 'tool-1')).not.toBe(questionKey('чат-2', 'tool-1'));
  });

  it('без id различаем по телу вызова', () => {
    const first = questionKey('чат-1', undefined, '{"questions":[{"question":"Куда деплоим?"}]}');
    const second = questionKey('чат-1', undefined, '{"questions":[{"question":"Ветку удалить?"}]}');
    expect(first).not.toBe(second);
    expect(questionKey('чат-1', undefined, 'одно и то же')).toBe(
      questionKey('чат-1', undefined, 'одно и то же'),
    );
  });

  it('пустой id не считается именем — берётся тело вызова', () => {
    expect(questionKey('чат-1', '', 'тело')).toBe(questionKey('чат-1', undefined, 'тело'));
  });
});

/**
 * Живой вопрос — из потока прогона. Регрессия: ответ, данный в черновике
 * `new-…`, после F5 не находился под sessionId, и карточка воскресала.
 */
describe('liveQuestionKey', () => {
  it('один вызов под разными именами разговора — одно имя', () => {
    expect(liveQuestionKey('new-1', 'toolu_1')).toBe(liveQuestionKey('session-1', 'toolu_1'));
  });

  it('разные вызовы — разные имена', () => {
    expect(liveQuestionKey('чат-1', 'toolu_1')).not.toBe(liveQuestionKey('чат-1', 'toolu_2'));
  });

  it('без id — по телу вызова в рамках разговора', () => {
    expect(liveQuestionKey('чат-1', undefined, 'тело')).toBe(
      questionKey('чат-1', undefined, 'тело'),
    );
    expect(liveQuestionKey('чат-1', undefined, 'тело')).not.toBe(
      liveQuestionKey('чат-2', undefined, 'тело'),
    );
  });
});
