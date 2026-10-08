/**
 * «Перевести задачи» групп разделения в трекере (G4). Переводит сама панель
 * своим клиентом Jira; `index` — задачи одной группы, без него — всего плана
 * с вложенными разделениями.
 */

export interface SplitTasksScope {
  parentChatId: string;
  index?: number;
}
