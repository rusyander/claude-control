import { describe, expect, it } from 'vitest';
import { chatWatchSignalsOf, type GroupSignal } from '@agentdeck/contracts/group-watch';
import { topSeverity, watchSignalsOf } from './watchSignalsOf';

const signal = (id: string, severity: GroupSignal['severity'], chatId = 'chat-1'): GroupSignal => ({
  id,
  rule: 'R24',
  severity,
  groupIndex: -1,
  chatId,
  at: '2026-10-23T10:00:00.000Z',
  numbers: { fails: 3 },
  textKey: 'groupWatch.rule.R24',
});

/**
 * Сигналы одиночного чата по обоим ключам разговора: ответ сервера разбирается
 * той же функцией, что и в хуке (`chatWatchSignalsOf`), — закрытые и битые
 * выпадают до поиска, один сигнал под двумя ключами считается один раз.
 */
describe('watchSignalsOf — сигналы одиночного чата по его ключам', () => {
  const view = chatWatchSignalsOf({
    signals: {
      'chat-1': [
        signal('a', 'warn'),
        { ...signal('old', 'alert'), clearedAt: '2026-10-23T11:00Z' },
      ],
      'session-1': [signal('a', 'warn'), signal('b', 'alert', 'session-1'), { id: 'broken' }],
      other: [signal('c', 'info', 'other')],
    },
  });

  it('оба ключа, без повторов, без закрытых и битых, чужой чат не попадает', () => {
    expect(watchSignalsOf(view, ['chat-1', 'session-1']).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('нет ответа или ключа — пусто', () => {
    expect(watchSignalsOf(undefined, ['chat-1'])).toEqual([]);
    expect(watchSignalsOf(view, [undefined, 'missing'])).toEqual([]);
  });

  it('уровень — самый важный из активных', () => {
    expect(topSeverity(watchSignalsOf(view, ['chat-1', 'session-1']))).toBe('alert');
    expect(topSeverity(watchSignalsOf(view, ['chat-1']))).toBe('warn');
    expect(topSeverity([])).toBeUndefined();
  });
});
