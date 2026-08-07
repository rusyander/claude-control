import { describe, expect, it } from 'vitest';
import { composeAnswer, nextQuestion } from './composeAnswer';
import type { Question } from '../ui/QuestionCard.types';

const three: Question[] = [
  { header: 'Редактор', question: 'Чем строить?', options: [{ label: 'CodeMirror' }] },
  { header: 'База', question: 'С чем сравнивать?', options: [{ label: 'Транскрипт' }] },
  { header: 'Объём', question: 'Что входит?', multiSelect: true, options: [{ label: 'Дерево' }] },
];

describe('сборка ответа на карточку вопросов', () => {
  it('один вопрос — только подпись варианта', () => {
    const one: Question[] = [{ header: 'Редактор', options: [{ label: 'CodeMirror 6' }] }];
    expect(composeAnswer(one, { 0: ['CodeMirror 6'] })).toBe('CodeMirror 6');
  });

  it('несколько вопросов уходят одним сообщением, по строке на вопрос', () => {
    const text = composeAnswer(three, { 0: ['CodeMirror'], 1: ['Транскрипт'], 2: ['Дерево'] });
    expect(text).toBe('Редактор: CodeMirror\nБаза: Транскрипт\nОбъём: Дерево');
  });

  it('множественный выбор перечисляется через запятую', () => {
    const text = composeAnswer(three, { 0: ['A'], 1: ['B'], 2: ['Дерево', 'Дифф'] });
    expect(text).toContain('Объём: Дерево, Дифф');
  });

  it('без заголовка подписью служит сам вопрос', () => {
    const pair: Question[] = [{ question: 'Первый?' }, { question: 'Второй?' }];
    expect(composeAnswer(pair, { 0: ['да'], 1: ['нет'] })).toBe('Первый?: да\nВторой?: нет');
  });

  it('вопрос без ответа в текст не попадает', () => {
    expect(composeAnswer(three, { 0: ['CodeMirror'] })).toBe('Редактор: CodeMirror');
  });

  it('пустая карточка даёт пустую строку — отправлять нечего', () => {
    expect(composeAnswer(three, {})).toBe('');
  });
});

describe('какой вопрос спрашиваем сейчас', () => {
  it('пока не отвечено — первый', () => {
    expect(nextQuestion(three, {}, {})).toBe(0);
  });

  it('после ответа — следующий', () => {
    expect(nextQuestion(three, { 0: ['CodeMirror'] }, {})).toBe(1);
  });

  it('множественный выбор не закрывается первой галочкой', () => {
    const picked = { 0: ['CodeMirror'], 1: ['Транскрипт'], 2: ['Дерево'] };
    expect(nextQuestion(three, picked, {})).toBe(2);
    expect(nextQuestion(three, picked, { 2: true })).toBeUndefined();
  });

  it('отвечены все — спрашивать нечего, карточка готова к отправке', () => {
    const pair: Question[] = [{ question: 'Первый?' }, { question: 'Второй?' }];
    expect(nextQuestion(pair, { 0: ['да'], 1: ['нет'] }, {})).toBeUndefined();
  });
});
