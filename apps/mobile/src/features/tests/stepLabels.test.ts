import { describe, expect, it } from 'vitest';
import { stepText } from '@agentdeck/contracts/test-format';
import { en } from '../../shared/config/i18n/en';
import { ru } from '../../shared/config/i18n/ru';

const step = { action: 'Open the list', data: 'user=qa', expected: 'The list opens' };

describe('шаг кейса одной строкой на экране телефона', () => {
  // Английский телефон показывал «данные:» и «ожидание:» посреди английского
  // текста: подписи шага жили в общем модуле только по-русски.
  it('английский интерфейс — английские подписи, без кириллицы', () => {
    const line = stepText(step, en.tests.stepLabels);
    expect(line).toBe('Open the list · data: user=qa · expected: The list opens');
    expect(line).not.toMatch(/[а-яё]/i);
  });

  it('русский интерфейс — прежняя строка, байт в байт', () => {
    expect(stepText(step, ru.tests.stepLabels)).toBe(stepText(step));
  });
});
