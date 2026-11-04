import { describe, expect, it } from 'vitest';
import { notificationTarget } from './model';

describe('notificationTarget', () => {
  it('ключ с приставкой CLI — разговор этого CLI', () => {
    expect(
      notificationTarget({ kind: 'done', chatId: 'codex:c1a2', projectPath: 'C:\\p' }),
    ).toEqual({
      kind: 'foreign',
      providerId: 'codex',
      chatId: 'c1a2',
    });
  });

  it('сессия Claude — его чат с проектом', () => {
    expect(
      notificationTarget({ kind: 'permission', chatId: '0f1e-uuid', projectPath: '/repo' }),
    ).toEqual({ kind: 'claude', chatId: '0f1e-uuid', projectPath: '/repo' });
  });

  it('проверочное уведомление, пустой и чужой ключ — никуда', () => {
    expect(notificationTarget({ kind: 'test', chatId: '' })).toBeUndefined();
    expect(notificationTarget({ kind: 'done' })).toBeUndefined();
    expect(notificationTarget('codex:c1')).toBeUndefined();
    expect(notificationTarget(null)).toBeUndefined();
    // `claude:` — не адрес: у Claude разговор без приставки.
    expect(notificationTarget({ chatId: 'claude:abc' })).toBeUndefined();
  });
});
