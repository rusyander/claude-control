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

/** Тип перехода истории, как его сообщает `router.history.subscribe`. */
export type HistoryActionType = 'PUSH' | 'REPLACE' | 'BACK' | 'FORWARD' | 'GO';

/** Назад, вперёд и `go(n)` — возврат к записи, где читатель уже был. */
export function isHistoryMove(action: HistoryActionType | undefined): boolean {
  return action === 'BACK' || action === 'FORWARD' || action === 'GO';
}

/** Якорь адреса без решётки; битая %-последовательность — не якорь, а не исключение. */
export function anchorOf(hash: string): string {
  const raw = hash.replace(/^#/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

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
