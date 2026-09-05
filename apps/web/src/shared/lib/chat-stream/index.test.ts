import { describe, it, expect } from 'vitest';
import { isStreamShown } from './index';

/**
 * Одно условие на двоих: по нему лента рисует потоковый пузырь и по нему же
 * прячет тот же ход из истории. Проверяем именно связку — разойдись стороны, и
 * ход либо задвоится, либо исчезнет с экрана совсем.
 */
describe('isStreamShown — кто рисует текущий ход', () => {
  it('прогон идёт — пузырь наш, даже пока текста нет', () => {
    expect(isStreamShown({ isRunning: true, text: '' })).toBe(true);
  });

  it('прогон кончился, но текст на экране — пузырь всё ещё наш', () => {
    expect(isStreamShown({ isRunning: false, text: 'ответ' })).toBe(true);
  });

  it('ни того ни другого — ход показывает история', () => {
    expect(isStreamShown({ isRunning: false, text: '' })).toBe(false);
  });

  it('связь потеряна — пузырь уступает истории, даже если прогон идёт', () => {
    // Ровно тот случай, на который жаловались: текст в пузыре оборван на
    // полуслове, а полный ответ уже в транскрипте. Показывать надо его.
    expect(isStreamShown({ isRunning: true, text: 'начал отве', stalled: true })).toBe(false);
  });
});
