import { describe, it, expect } from 'vitest';
import { sanitizePrefs } from './chatPrefsStore';

/**
 * Тесты санитайза настроек чата из localStorage. Ключевое: по умолчанию правки
 * разрешены, а мусор не ломает тумблер. Тест-кейсы см. .agent/TEST-CASES.md →
 * «Настройки чата (chatPrefs)».
 */
describe('sanitizePrefs', () => {
  it('по умолчанию правки разрешены', () => {
    expect(sanitizePrefs(undefined).allowEdits).toBe(true);
    expect(sanitizePrefs({}).allowEdits).toBe(true);
    expect(sanitizePrefs('мусор').allowEdits).toBe(true);
  });

  it('сохраняет явно выключённое значение', () => {
    expect(sanitizePrefs({ allowEdits: false }).allowEdits).toBe(false);
  });

  it('нелогический тип игнорируется → дефолт true', () => {
    expect(sanitizePrefs({ allowEdits: 'yes' }).allowEdits).toBe(true);
  });

  it('звук уведомлений по умолчанию включён, но выключенный сохраняется', () => {
    expect(sanitizePrefs(undefined).sound).toBe(true);
    expect(sanitizePrefs({}).sound).toBe(true);
    expect(sanitizePrefs({ sound: false }).sound).toBe(false);
  });
});
