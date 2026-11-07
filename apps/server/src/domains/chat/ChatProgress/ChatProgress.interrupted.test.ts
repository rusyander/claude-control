import { describe, expect, it } from 'vitest';
import { isInterruptedResult } from './ChatProgress.ts';

/**
 * Обрыв вызова паузой или концом сессии — не ошибка вызова. Проверка жила в разборе истории
 * агентов по транскриптам (снят в W3-17, этап 11); правило осталось у прогресса чата.
 */
describe('ChatProgress — interrupted tool result', () => {
  it('the CLI interrupt marker is an interruption, a command that merely prints it is not', () => {
    expect(
      isInterruptedResult(
        "  [Tool call interrupted: the session ended before this call's result was recorded]",
      ),
    ).toBe(true);
    expect(isInterruptedResult('exit 1: [Tool call interrupted]')).toBe(false);
  });
});
