import { describe, it, expect } from 'vitest';
import { ViewerPresence } from './viewer-presence.ts';

/**
 * «Человек смотрит» с окном: перезапуск панели и переподключение вкладки не
 * должны делать автономный чат «брошенным» на секунду переподключения.
 */
describe('ViewerPresence', () => {
  const WINDOW = 10 * 60_000;

  it('потока не было: панель моложе окна — смотрит, старше — нет', () => {
    const presence = new ViewerPresence(1_000);
    expect(presence.recentlySeen(['c'], WINDOW, 1_000 + WINDOW - 1)).toBe(true);
    expect(presence.recentlySeen(['c'], WINDOW, 1_000 + WINDOW)).toBe(false);
  });

  it('отметка решает вместо возраста панели: давняя — не смотрит, хотя панель молода', () => {
    const presence = new ViewerPresence(0);
    presence.mark(['c'], 0);
    expect(presence.recentlySeen(['c'], 100, 50)).toBe(true);
    expect(presence.recentlySeen(['c'], 100, 150)).toBe(false);
  });

  it('любой ключ разговора: отметка под sessionId видна по ключу чата', () => {
    const presence = new ViewerPresence(0);
    presence.mark(['sess'], 5_000_000);
    expect(presence.recentlySeen(['new-1', 'sess'], WINDOW, 5_000_100)).toBe(true);
    expect(presence.recentlySeen(['other'], WINDOW, 5_000_100 + WINDOW)).toBe(false);
  });

  it('берётся самая свежая отметка из ключей', () => {
    const presence = new ViewerPresence(0);
    presence.mark(['a'], 0);
    presence.mark(['b'], 900);
    expect(presence.recentlySeen(['a', 'b'], 200, 1_000)).toBe(true);
  });

  it('окно ноль — только поток сейчас, отметки не спасают', () => {
    const presence = new ViewerPresence(0);
    presence.mark(['c'], 0);
    expect(presence.recentlySeen(['c'], 0, 0)).toBe(false);
  });

  it('карта не растёт без конца: самая давняя запись забывается', () => {
    const presence = new ViewerPresence(0);
    for (let index = 0; index <= 500; index += 1) presence.mark([`k${index}`], 10_000_000);
    // k0 забыт — по нему судит возраст панели (давно старше окна).
    expect(presence.recentlySeen(['k0'], WINDOW, 10_000_001)).toBe(false);
    expect(presence.recentlySeen(['k500'], WINDOW, 10_000_001)).toBe(true);
  });
});
