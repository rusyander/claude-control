import { describe, it, expect, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: { defaults: { baseURL: '/api' }, post: vi.fn(), get: vi.fn() },
}));

import { KEEPALIVE_BYTES, sendInit } from './agent-runs.stream';

/**
 * Отправка переживает вкладку (`keepalive`).
 *
 * Регрессия, ради которой написано (06.09, живой прогон): ответ на вопрос
 * агента ушёл из очереди по концу хода, а F5 в ту же секунду отменил ещё не
 * ушедший `POST /chat/send` — из очереди вынуто, до сервера не дошло, сообщение
 * пропало молча. С `keepalive` браузер досылает запрос уже без страницы.
 */
describe('sendInit — запрос отправки', () => {
  it('короткое сообщение уходит с keepalive', () => {
    const init = sendInit(JSON.stringify({ chatId: 'c', prompt: 'Вариант Альфа' }));
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
  });

  it('квота считается в байтах: кириллица втрое длиннее своей длины в символах', () => {
    // 7 000 символов кириллицы = 14 000 байт — ещё в квоте.
    expect(sendInit('я'.repeat(7_000)).keepalive).toBe(true);
    // 9 000 символов = 18 000 байт — уже нет, хотя символов меньше лимита.
    expect(9_000).toBeLessThan(KEEPALIVE_BYTES);
    expect(sendInit('я'.repeat(9_000)).keepalive).toBeUndefined();
  });

  it('тело с вложением идёт обычным запросом', () => {
    const body = JSON.stringify({
      chatId: 'c',
      prompt: 'см. файл',
      files: [{ data: 'A'.repeat(20_000) }],
    });
    expect(sendInit(body).keepalive).toBeUndefined();
    expect(sendInit(body).body).toBe(body);
  });
});
