import { describe, expect, it } from 'vitest';
import { skillTextSteps } from './skillText';
import { stepOfQuote } from './stepOfQuote';

const SKILL = [
  'Intro line.',
  '',
  '## 1. Prepare',
  'Collect the diff.',
  '',
  '## 2. Review',
  'Run **up to 3**',
  'rounds; each `round` has 2 agents.',
].join('\n');

describe('цитата числа находит шаг, как у сервера (F-230)', () => {
  it('разметка и перенос строки в тексте не мешают найти цитату', () => {
    const steps = skillTextSteps(SKILL);
    expect(stepOfQuote(steps, SKILL, 'Run up to 3 rounds')).toBe(1);
    expect(stepOfQuote(steps, SKILL, 'each round has 2 agents')).toBe(1);
  });

  it('точная цитата и отсутствующая — как прежде', () => {
    const steps = skillTextSteps(SKILL);
    expect(stepOfQuote(steps, SKILL, 'Collect the diff.')).toBe(0);
    expect(stepOfQuote(steps, SKILL, 'absent')).toBeUndefined();
    expect(stepOfQuote(steps, SKILL, 'Intro line')).toBeUndefined();
  });
});

// Ревью 28.09 (F-258): «~~~» внутри блока «```» закрывал его — пример
// заголовка из блока кода становился шагом. Правило то же, что у сервера
// (`stepHeadings`, CommonMark): закрывает тот же знак не короче открывшего.
describe('блок кода закрывается только своей оградой, как у сервера (F-258)', () => {
  it('чужая или короткая ограда внутри блока не выпускает пример заголовка в шаги', () => {
    const text = [
      '## 1. Prepare',
      '````md',
      '~~~',
      '## 9. Example inside the block',
      '```',
      '## 8. Still inside',
      '````',
      '## 2. Review',
    ].join('\n');
    expect(skillTextSteps(text).map((step) => step.title)).toEqual(['Prepare', 'Review']);
  });
});

describe('разбор текста скилла не повторяется на каждую строку (F-229)', () => {
  it('тот же текст — тот же разбор', () => {
    expect(skillTextSteps(SKILL)).toBe(skillTextSteps(SKILL));
  });
});

// Ревью 28.09 (F-230, паритет): свой разбор страницы расходился с серверным
// `knobStep` — число вставало на скилл целиком, пока сервер находил шаг. Теперь
// разбор один на двоих (`@agentdeck/contracts/skill-steps`).
describe('шаг числа — тот же разбор, что у сервера (F-230)', () => {
  const REPEATED = [
    'Intro: Run up to 3 rounds, as said below.',
    '',
    '## 1. Prepare',
    'Collect the diff.',
    '',
    '## 2. Review',
    'Run up to 3 rounds.',
  ].join('\n');

  it('та же фраза во вступлении и в шаге — шаг, а не вступление', () => {
    expect(stepOfQuote(skillTextSteps(REPEATED), REPEATED, 'Run up to 3 rounds')).toBe(1);
  });

  it('вступление называет шаг — «step 2», «§2», «шаг 2»', () => {
    for (const named of ['in step 2', 'in §2', 'на шаг 2']) {
      const text = [`Use 2 agents ${named}.`, '', '## 1. Prepare', 'x', '## 2. Review', 'y'].join(
        '\n',
      );
      expect(stepOfQuote(skillTextSteps(text), text, 'Use 2 agents'), named).toBe(1);
    }
  });

  it('«#» внутри блока кода не закрывает раздел шага', () => {
    const text = [
      '## 1. Prepare',
      '```bash',
      '# install deps',
      '```',
      'Retry 3 times.',
      '## 2. Review',
      'y',
    ].join('\n');
    expect(stepOfQuote(skillTextSteps(text), text, 'Retry 3 times.')).toBe(0);
  });

  it('номера по возрастанию считаются от последнего принятого шага (F-257)', () => {
    const text = ['## 3. A', 'a', '## 1. B', 'b', '## 2. C', 'c', '## 4. D', 'd'].join('\n');
    expect(skillTextSteps(text).map((step) => step.title)).toEqual(['A', 'D']);
  });
});
