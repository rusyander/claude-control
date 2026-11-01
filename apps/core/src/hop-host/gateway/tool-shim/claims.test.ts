import { describe, expect, it } from 'vitest';
import { claimedWithoutCall } from './claims.ts';

/**
 * Эвристика «сказала, но не сделала» (Т5.5).
 *
 * Проверяется в обе стороны, и вторая важнее: пометка, которая загорается на
 * обычном разговоре о файлах, обесценивает себя за один день — человек
 * перестаёт её читать ровно к тому ходу, в котором она права.
 */

const CLAIMS = [
  'Файл создан.',
  'Я записал файл src/app.ts.',
  'Готово: файл обновлён.',
  'Команда выполнена.',
  'I created the file.',
  "I've written src/app.ts.",
  'The file has been updated.',
];

const INNOCENT = [
  'Задача выполнима, но нужен путь к файлу.',
  'Я бы создал файл, но не знаю, куда его положить.',
  'Какой файл открыть?',
  'Файл не найден — проверь путь.',
  'Here is what the file contains.',
  '',
];

describe('модель заявила действие без вызова', () => {
  it.each(CLAIMS)('заявка: %s', (text) => {
    expect(claimedWithoutCall(text, 0)).toBe(true);
  });

  it.each(INNOCENT)('не заявка: %s', (text) => {
    expect(claimedWithoutCall(text, 0)).toBe(false);
  });

  it('состоявшийся вызов снимает вопрос целиком', () => {
    // Модель и сказала, и сделала — это обычный ход, а не подозрительный.
    expect(claimedWithoutCall('Файл создан.', 1)).toBe(false);
  });
});
