import { useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * Связка «открытый элемент ↔ адрес страницы».
 *
 * Работает в обе стороны. Переход по адресу с `?id=…` открывает нужный элемент
 * — правило, скилл, хук, разговор, — а открытие элемента дописывает его id в
 * адрес. Благодаря этому ссылкой на конкретную настройку можно поделиться,
 * вернуться к ней позже и не терять её при перезагрузке страницы.
 *
 * Список приходит с сервера не сразу, поэтому открытие ждёт данных: пока
 * элемента нет, ничего не происходит, и попытка повторяется на следующем
 * рендере. Открываем один раз на каждый id — иначе закрытая пользователем
 * форма открывалась бы снова.
 */

interface Options<T> {
  /** Элементы раздела. undefined, пока список грузится. */
  items: T[] | undefined;
  /** Идентификатор элемента — он же попадает в адрес. */
  getId: (item: T) => string;
  /** Открыть элемент: обычно это установка состояния формы. */
  onOpen: (item: T) => void;
}

export function useEntityUrl<T>({ items, getId, onOpen }: Options<T>): void {
  const { id } = useSearch({ strict: false }) as { id?: string };
  const openedId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!id || !items || openedId.current === id) return;

    const found = items.find((item) => getId(item) === id);
    if (!found) return;

    openedId.current = id;
    onOpen(found);
    // Список и обработчики меняются между рендерами, а открыть нужно ровно
    // один раз на каждый id — за этим следит ref, а не список зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, items]);
}

/**
 * Записать id открытого элемента в адрес или убрать его при закрытии.
 * Замена записи в истории, а не новая: возврат назад должен уводить со
 * страницы, а не отматывать по одному открытому элементу.
 */
export function useEntityUrlWriter(): (id: string | undefined) => void {
  const navigate = useNavigate();

  return (id) => {
    void navigate({ to: '.', search: id ? { id } : {}, replace: true });
  };
}
