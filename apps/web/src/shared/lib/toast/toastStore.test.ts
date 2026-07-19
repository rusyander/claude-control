import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toast, getToasts, subscribeToasts, dismissToast, clearToasts } from './toastStore';

/**
 * Стор уведомлений. Он модуль-синглтон и живёт всё время работы вкладки,
 * поэтому каждый тест начинается с очистки — иначе тосты предыдущего теста
 * утекут в следующий. Проверяем ровно то, за что стор отвечает: не показывать
 * пустое, не разрастаться без предела и будить подписчиков только когда
 * список действительно изменился.
 */

beforeEach(() => {
  clearToasts();
});

describe('добавление', () => {
  it('показывает сообщение с указанным тоном', () => {
    toast.success('Сохранено');
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]).toMatchObject({ tone: 'success', message: 'Сохранено' });
  });

  it('поддерживает все четыре тона', () => {
    toast.success('раз');
    toast.error('два');
    toast.warning('три');
    toast.info('четыре');
    expect(getToasts().map((item) => item.tone)).toEqual(['success', 'error', 'warning', 'info']);
  });

  it('возвращает идентификатор, по которому тост можно закрыть', () => {
    const id = toast.info('Сообщение');
    expect(id).not.toBe('');
    dismissToast(id);
    expect(getToasts()).toHaveLength(0);
  });

  it('выдаёт разные идентификаторы одинаковым сообщениям', () => {
    const first = toast.info('одно и то же');
    const second = toast.info('одно и то же');
    expect(first).not.toBe(second);
  });

  it('обрезает пробелы вокруг текста', () => {
    toast.info('  с пробелами  ');
    expect(getToasts()[0]?.message).toBe('с пробелами');
  });

  it('подставляет длительность по умолчанию', () => {
    toast.info('Сообщение');
    expect(getToasts()[0]?.duration).toBe(3000);
  });

  it('пропускает заданные заголовок и длительность', () => {
    toast.error('Не вышло', { title: 'Ошибка', duration: 9000 });
    expect(getToasts()[0]).toMatchObject({ title: 'Ошибка', duration: 9000 });
  });
});

describe('пустой текст', () => {
  it('пустое сообщение тост не создаёт', () => {
    expect(toast.info('')).toBe('');
    expect(getToasts()).toHaveLength(0);
  });

  it('сообщение из одних пробелов тоже не создаёт', () => {
    // Иначе на экране появлялась бы пустая плашка без объяснения.
    expect(toast.error('   \n\t ')).toBe('');
    expect(getToasts()).toHaveLength(0);
  });
});

describe('предел стопки', () => {
  it('держит не больше пяти тостов', () => {
    for (let index = 1; index <= 7; index += 1) toast.info(`сообщение ${index}`);
    expect(getToasts()).toHaveLength(5);
  });

  it('вытесняет старейший, сохраняя порядок появления', () => {
    for (let index = 1; index <= 7; index += 1) toast.info(`сообщение ${index}`);
    expect(getToasts().map((item) => item.message)).toEqual([
      'сообщение 3',
      'сообщение 4',
      'сообщение 5',
      'сообщение 6',
      'сообщение 7',
    ]);
  });
});

describe('закрытие', () => {
  it('убирает только указанный тост', () => {
    const first = toast.info('первый');
    toast.info('второй');
    dismissToast(first);
    expect(getToasts().map((item) => item.message)).toEqual(['второй']);
  });

  it('закрытие несуществующего идентификатора ничего не меняет', () => {
    toast.info('единственный');
    dismissToast('toast-которого-нет');
    expect(getToasts()).toHaveLength(1);
  });

  it('очистка убирает все разом', () => {
    toast.info('раз');
    toast.info('два');
    clearToasts();
    expect(getToasts()).toHaveLength(0);
  });
});

describe('подписка', () => {
  it('сообщает подписчику о новом тосте', () => {
    const listener = vi.fn();
    subscribeToasts(listener);
    toast.info('Сообщение');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('после отписки уведомления не приходят', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    unsubscribe();
    toast.info('Сообщение');
    expect(listener).not.toHaveBeenCalled();
  });

  it('не будит подписчиков, когда список не изменился', () => {
    // Лишний вызов означал бы лишний рендер на каждое промазавшее закрытие.
    toast.info('единственный');
    const listener = vi.fn();
    subscribeToasts(listener);

    dismissToast('toast-которого-нет');
    expect(listener).not.toHaveBeenCalled();

    clearToasts();
    expect(listener).toHaveBeenCalledTimes(1);

    // Очистка уже пустого списка тоже молчит.
    listener.mockClear();
    clearToasts();
    expect(listener).not.toHaveBeenCalled();
  });

  it('пустое сообщение подписчиков не будит', () => {
    const listener = vi.fn();
    subscribeToasts(listener);
    toast.info('   ');
    expect(listener).not.toHaveBeenCalled();
  });
});
