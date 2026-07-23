import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToastItem } from './toast.types';
import {
  recordToast,
  getToastHistory,
  getUnreadCount,
  markToastsRead,
  clearToastHistory,
  subscribeToastHistory,
} from './toastHistoryStore';

/**
 * Журнал уведомлений. Он модуль-синглтон и живёт всё время работы вкладки,
 * поэтому каждый тест начинается с очистки. Проверяем, за что журнал отвечает:
 * держать последние N с новейшими сверху, считать непрочитанные и будить
 * подписчиков на изменения.
 */

let sequence = 0;
function makeToast(over: Partial<ToastItem> = {}): ToastItem {
  sequence += 1;
  return {
    id: `toast-${sequence}`,
    tone: 'info',
    message: `сообщение ${sequence}`,
    duration: 3000,
    ...over,
  };
}

beforeEach(() => {
  clearToastHistory();
});

describe('запись', () => {
  it('заносит показанный тост в журнал', () => {
    recordToast(makeToast({ tone: 'success', message: 'Сохранено' }));
    expect(getToastHistory()).toHaveLength(1);
    expect(getToastHistory()[0]).toMatchObject({ tone: 'success', message: 'Сохранено' });
  });

  it('проставляет время появления', () => {
    recordToast(makeToast());
    expect(typeof getToastHistory()[0]?.at).toBe('number');
  });

  it('новейшие записи идут первыми', () => {
    recordToast(makeToast({ id: 'a', message: 'первое' }));
    recordToast(makeToast({ id: 'b', message: 'второе' }));
    expect(getToastHistory().map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('не переносит действие по клику и длительность', () => {
    recordToast(makeToast({ onClick: () => undefined, duration: 9000 }));
    const entry = getToastHistory()[0] as unknown as Record<string, unknown>;
    expect(entry.onClick).toBeUndefined();
    expect(entry.duration).toBeUndefined();
  });
});

describe('кольцо на N', () => {
  it('держит не больше тридцати записей', () => {
    for (let index = 0; index < 42; index += 1) recordToast(makeToast());
    expect(getToastHistory()).toHaveLength(30);
  });

  it('вытесняет старейшие, оставляя последние тридцать', () => {
    const ids: string[] = [];
    for (let index = 0; index < 35; index += 1) {
      const id = `n-${index}`;
      ids.push(id);
      recordToast(makeToast({ id }));
    }
    // Новейшие сверху: первым — последний записанный, последним в списке — n-5.
    const history = getToastHistory();
    expect(history[0]?.id).toBe('n-34');
    expect(history[history.length - 1]?.id).toBe('n-5');
    expect(history.some((entry) => entry.id === 'n-4')).toBe(false);
  });
});

describe('непрочитанные', () => {
  it('каждая запись увеличивает счётчик', () => {
    recordToast(makeToast());
    recordToast(makeToast());
    expect(getUnreadCount()).toBe(2);
  });

  it('отметка «прочитано» обнуляет счётчик, но не трогает список', () => {
    recordToast(makeToast());
    recordToast(makeToast());
    markToastsRead();
    expect(getUnreadCount()).toBe(0);
    expect(getToastHistory()).toHaveLength(2);
  });

  it('очистка убирает и записи, и счётчик', () => {
    recordToast(makeToast());
    clearToastHistory();
    expect(getToastHistory()).toHaveLength(0);
    expect(getUnreadCount()).toBe(0);
  });
});

describe('подписка', () => {
  it('сообщает подписчику о новой записи', () => {
    const listener = vi.fn();
    subscribeToastHistory(listener);
    recordToast(makeToast());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('после отписки уведомления не приходят', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToastHistory(listener);
    unsubscribe();
    recordToast(makeToast());
    expect(listener).not.toHaveBeenCalled();
  });

  it('пустая отметка «прочитано» подписчиков не будит', () => {
    const listener = vi.fn();
    subscribeToastHistory(listener);
    markToastsRead();
    expect(listener).not.toHaveBeenCalled();
  });
});
