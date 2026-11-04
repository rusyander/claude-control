import { describe, expect, it } from 'vitest';
import { viewOf } from './stream-view.ts';

/**
 * Конец хода в виде сеанса: у хода с ошибкой — слова CLI о ней (текст результата), у удачного —
 * без текста (он уже пришёл кусками `assistant-text`, повтор задвоил бы ответ в показе).
 */
const ended = (isError: boolean, text: string) =>
  viewOf({ type: 'turn.ended', attribution: 'c1', origin: 'echo', isError, numTurns: 1, text });

describe('stream view — window (pass 8)', () => {
  const window = (warning: boolean, refusal: boolean, windows?: Record<string, never>) =>
    viewOf({
      type: 'window',
      limitKind: 'window',
      usedPct: 50,
      resetAt: 9000,
      warning,
      refusal,
      window: 'five_hour',
      ...(windows ? { windows } : {}),
    });

  it('status in the Claude Code words: refusal wins over a warning, nothing = allowed; samples ride along', () => {
    expect(window(false, false)).toEqual({
      kind: 'window',
      data: {
        limitKind: 'window',
        usedPct: 50,
        resetAt: 9000,
        status: 'allowed',
        window: 'five_hour',
      },
    });
    expect(window(true, false)?.data).toMatchObject({ status: 'allowed_warning' });
    expect(window(true, true)?.data).toMatchObject({ status: 'rejected' });
    expect(window(false, true)?.data).toMatchObject({ status: 'rejected' });
    expect(window(false, false, {})?.data).toHaveProperty('windows', {});
  });
});

describe('stream view — turn-end', () => {
  it('an error turn carries the CLI words about the error', () => {
    expect(ended(true, 'API Error: 400 qa-model: request refused by the stub')).toEqual({
      kind: 'turn-end',
      data: {
        isError: true,
        numTurns: 1,
        text: 'API Error: 400 qa-model: request refused by the stub',
      },
    });
  });

  it('a good turn and an error without words carry no text', () => {
    expect(ended(false, 'ответ')).toEqual({
      kind: 'turn-end',
      data: { isError: false, numTurns: 1 },
    });
    expect(ended(true, '')).toEqual({ kind: 'turn-end', data: { isError: true, numTurns: 1 } });
  });
});
