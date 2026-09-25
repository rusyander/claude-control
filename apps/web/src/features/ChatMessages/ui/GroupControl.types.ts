/**
 * Что можно сделать с группой из строки хаба (журнал 81, 89): поставить на
 * паузу работающую, продолжить остановленную, запустить сейчас ждущую в очереди.
 */
export interface GroupControlState {
  /** Родитель разделения — ключ записи конвейера. */
  parentChatId: string;
  /** Номер группы в конвейере — им адресуется запрос родителю. */
  index: number;
  action: 'pause' | 'resume' | 'start';
  /** Лимит подписки исчерпан: до какого момента группа (или очередь) ждёт сброса (ISO). */
  limitUntil?: string;
}

export interface GroupControlProps {
  control: GroupControlState;
}
