import { describe, expect, it, vi } from 'vitest';
import { applyRestart } from './applyRestart';

/**
 * «Чистая сессия» с телефона: ответ сервера решает, отправить просьбу обновить
 * файл-опору или перейти в уже заведённое продолжение. Ошибка отправки должна
 * дойти до кнопки — иначе подтверждение закрылось бы молча.
 */
describe('чистая сессия на телефоне', () => {
  it('опора не свежа — просьба уходит обычным сообщением, перехода нет', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const open = vi.fn();

    await applyRestart({ mode: 'requested', prompt: 'обнови опору' }, { send, open }, 'сбой');

    expect(send).toHaveBeenCalledWith('обнови опору');
    expect(open).not.toHaveBeenCalled();
  });

  it('продолжение заведено — экран переходит в него, ничего не отправляя', async () => {
    const send = vi.fn();
    const open = vi.fn();

    await applyRestart({ mode: 'started', chatId: 'c-2', path: 'p' }, { send, open }, 'сбой');

    expect(open).toHaveBeenCalledWith({ mode: 'started', chatId: 'c-2', path: 'p' });
    expect(send).not.toHaveBeenCalled();
  });

  it('отправка не удалась — ошибка с текстом для кнопки', async () => {
    const send = vi.fn().mockResolvedValue(false);

    await expect(
      applyRestart({ mode: 'requested', prompt: 'x' }, { send, open: vi.fn() }, 'не отправилось'),
    ).rejects.toThrow('не отправилось');
  });
});
