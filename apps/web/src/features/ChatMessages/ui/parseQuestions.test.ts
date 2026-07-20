import { describe, it, expect } from 'vitest';
import { parseQuestions } from './QuestionCard';

/**
 * Разбор input вызова AskUserQuestion в кликабельные варианты ответа. Формат нам
 * неподконтролен (приходит строкой JSON от модели), поэтому парсер обязан быть
 * устойчивым к мусору и не падать. Позитив (корректный вопрос), негатив
 * (сломанный JSON/не тот формат) и край (пустой список, null, число).
 */
describe('parseQuestions', () => {
  it('разбирает корректный вопрос с вариантами', () => {
    const input = JSON.stringify({
      questions: [
        {
          question: 'Какой роутер?',
          header: 'Роутинг',
          multiSelect: false,
          options: [{ label: 'TanStack', description: 'уже в проекте' }, { label: 'React Router' }],
        },
      ],
    });
    const result = parseQuestions(input);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.options).toHaveLength(2);
    expect(result?.[0]?.options?.[0]?.label).toBe('TanStack');
  });

  it('несколько вопросов сохраняются в порядке', () => {
    const input = JSON.stringify({
      questions: [{ question: 'A' }, { question: 'B' }],
    });
    expect(parseQuestions(input)?.map((q) => q.question)).toEqual(['A', 'B']);
  });

  it('сломанный JSON → undefined (не падаем)', () => {
    expect(parseQuestions('это не json')).toBeUndefined();
    expect(parseQuestions('{questions:[]}')).toBeUndefined();
    expect(parseQuestions('')).toBeUndefined();
  });

  it('пустой список вопросов → undefined (показывать нечего)', () => {
    expect(parseQuestions(JSON.stringify({ questions: [] }))).toBeUndefined();
  });

  it('нет поля questions → undefined', () => {
    expect(parseQuestions(JSON.stringify({ foo: 'bar' }))).toBeUndefined();
  });

  it('questions не массив → undefined', () => {
    expect(parseQuestions(JSON.stringify({ questions: 'строка' }))).toBeUndefined();
  });

  it('край: null и число не роняют парсер', () => {
    expect(parseQuestions('null')).toBeUndefined();
    expect(parseQuestions('123')).toBeUndefined();
    expect(parseQuestions('"строка"')).toBeUndefined();
  });
});
