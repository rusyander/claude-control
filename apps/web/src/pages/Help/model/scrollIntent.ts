import type { HistoryActionType } from './topicScroll.types';
import { anchorOf } from './anchorOf';
import { isHistoryMove } from './topicScroll';

/**
 * Куда поставить прокрутку, когда в справке сменился адрес.
 *
 * Прокручивается не окно, а колонка раздела (`main`, см. MainLayout), поэтому
 * сброс прокрутки роутера, который трогает только окно, справке ничего не
 * давал: «Следующий раздел» открывал новый документ на той же высоте, где
 * читатель бросил прошлый, — на девятитысячном пикселе чужого текста.
 *
 * Три случая, по старшинству:
 *  1. в адресе якорь (`#…`) — к нему: ссылка на место в документе важнее всего;
 *  2. переход по истории (Назад/Вперёд) и позиция этой записи известна —
 *     вернуть её: так ведёт себя браузер на обычной странице;
 *  3. всё остальное (новая ссылка, первый заход) — в начало документа.
 */
export type ScrollIntent =
  { kind: 'anchor'; id: string } | { kind: 'restore'; top: number } | { kind: 'top' };

export function scrollIntent(input: {
  hash: string;
  action: HistoryActionType | undefined;
  saved: number | undefined;
}): ScrollIntent {
  const id = anchorOf(input.hash);
  if (id) return { kind: 'anchor', id };
  if (isHistoryMove(input.action) && input.saved !== undefined) {
    return { kind: 'restore', top: input.saved };
  }
  return { kind: 'top' };
}
