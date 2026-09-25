import { describe, it, expect } from 'vitest';
import {
  sanitizePrefs,
  getChatPrefs,
  setAllowEdits,
  setSound,
  subscribeChatPrefs,
} from './chatPrefsStore';

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

  /**
   * Громкость по умолчанию 200%: базовый синтезированный тон слышно едва, и
   * ради него настройка и заводилась. Мусор и выход за границы не должны ни
   * оглушать, ни выключать звук молча.
   */
  it('громкость: дефолт 200%, мусор → дефолт, выход за границы обрезается', () => {
    expect(sanitizePrefs(undefined).soundVolume).toBe(2);
    expect(sanitizePrefs({ soundVolume: 'громко' as unknown as number }).soundVolume).toBe(2);
    expect(sanitizePrefs({ soundVolume: Number.NaN }).soundVolume).toBe(2);
    expect(sanitizePrefs({ soundVolume: 99 }).soundVolume).toBe(4);
    expect(sanitizePrefs({ soundVolume: -5 }).soundVolume).toBe(0);
    expect(sanitizePrefs({ soundVolume: 1.5 }).soundVolume).toBe(1.5);
  });
});

/**
 * Реактивный стор настроек: сеттеры меняют значение, уведомляют подписчиков и не
 * шумят при установке того же значения. Стор — модульный синглтон, поэтому
 * значения задаём явно (не полагаемся на порядок тестов). localStorage в
 * node-окружении нет — доступ к нему в сторе обёрнут опционально, стор работает
 * в памяти.
 */
describe('chatPrefs — сеттеры и подписка', () => {
  it('setAllowEdits меняет значение и уведомляет подписчиков', () => {
    // Приводим к известному состоянию.
    setAllowEdits(true);

    let notified = 0;
    const unsubscribe = subscribeChatPrefs(() => {
      notified += 1;
    });

    setAllowEdits(false);
    expect(getChatPrefs().allowEdits).toBe(false);
    expect(notified).toBe(1);

    unsubscribe();
    setAllowEdits(true); // после отписки не считаем
    expect(notified).toBe(1);
    expect(getChatPrefs().allowEdits).toBe(true);
  });

  it('установка того же значения — без уведомления (no-op)', () => {
    setSound(true);

    let notified = 0;
    const unsubscribe = subscribeChatPrefs(() => {
      notified += 1;
    });

    setSound(true); // значение не изменилось
    expect(notified).toBe(0);

    setSound(false); // изменилось — одно уведомление
    expect(notified).toBe(1);
    expect(getChatPrefs().sound).toBe(false);

    unsubscribe();
  });

  it('allowEdits и sound независимы друг от друга', () => {
    setAllowEdits(false);
    setSound(true);
    expect(getChatPrefs()).toMatchObject({ allowEdits: false, sound: true });

    setAllowEdits(true);
    expect(getChatPrefs()).toMatchObject({ allowEdits: true, sound: true });
  });
});
