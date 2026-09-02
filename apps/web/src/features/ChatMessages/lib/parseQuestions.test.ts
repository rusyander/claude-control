import { describe, it, expect } from 'vitest';
import { parseQuestions } from './parseQuestions';

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

/**
 * Один и тот же вызов приезжает в панель дважды и в разных видах: из потока —
 * строкой JSON, из запроса прав perm-guard — уже объектом. Карточка одна, значит
 * и разбор обязан принимать оба, иначе живой вопрос (тот, на котором агент
 * стоит) просто не нарисуется.
 */
describe('parseQuestions: input объектом, как его отдаёт perm-guard', () => {
  it('объект разбирается так же, как строка', () => {
    const payload = {
      questions: [{ question: 'Какой формат?', options: [{ label: 'ISO' }, { label: 'Локальный' }] }],
    };
    expect(parseQuestions(payload)).toEqual(payload.questions);
    expect(parseQuestions(payload)).toEqual(parseQuestions(JSON.stringify(payload)));
  });

  it('объект без вопросов и не-объект → undefined', () => {
    expect(parseQuestions({ questions: [] })).toBeUndefined();
    expect(parseQuestions({ foo: 'bar' })).toBeUndefined();
    expect(parseQuestions(undefined)).toBeUndefined();
    expect(parseQuestions(null)).toBeUndefined();
    expect(parseQuestions(42)).toBeUndefined();
  });
});
