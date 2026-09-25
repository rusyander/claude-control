import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../../shared/api/client', () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

import { chatAutoModeQuery, shownAutoMode } from './api';

/**
 * Переключатель авторежима на телефоне показывает то, что решит сервер: выбор
 * чата, иначе глобальную настройку панели. Раньше он из коробки горел «вкл»,
 * даже когда в панели авторежим выключен.
 */
describe('авторежим чата на телефоне', () => {
  afterEach(() => get.mockReset());

  it('спрашивает сервер по чату и настоящему id разговора', async () => {
    get.mockResolvedValue({ enabled: false, global: false });
    const view = await chatAutoModeQuery('new-1', 'сессия 7').queryFn();

    expect(view).toEqual({ enabled: false, global: false });
    expect(get).toHaveBeenCalledWith('/chat/new-1/auto-mode', { sessionId: 'сессия 7' });
  });

  it('глобально выключен и чат не выбирал — переключатель выключен', () => {
    expect(shownAutoMode(undefined, { enabled: false, global: false })).toBe(false);
  });

  it('выбор, сделанный здесь, сильнее ответа сервера в обе стороны', () => {
    expect(shownAutoMode(true, { enabled: false, global: false })).toBe(true);
    expect(shownAutoMode(false, { enabled: true, global: true })).toBe(false);
  });

  it('сервер ещё не ответил — «вкл», как у панели из коробки', () => {
    expect(shownAutoMode(undefined, undefined)).toBe(true);
  });
});
