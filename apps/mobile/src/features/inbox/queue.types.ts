/**
 * Карточка вопросов ОДНОГО чата: по одному вопросу за раз.
 *
 * Ответ на текущий вопрос сворачивает его в строку с выбранным и открывает
 * следующий; после последнего — одна кнопка «Отправить» на весь чат. Так же,
 * как карточка вопросов в панели: каждое сообщение — это ход агента, и ответ
 * на вопрос с вариантами обязан уехать ОДНИМ сообщением, иначе агент отвечал
 * бы на первый вопрос, ничего не зная про остальные. Решения по правам уходят
 * тем же нажатием — отдельными запросами, но из той же карточки: человек
 * отвечает «за чат», а не за каждый запрос порознь.
 *
 * Состояние — чистые данные: сервер опрашивается каждые несколько секунд, и
 * вопросы между опросами приходят и уходят. `reconcile` сводит выбранное с
 * тем, что сервер отдаёт сейчас.
 */

export type AskAnswer =
  | { kind: 'permission'; behavior: 'allow' | 'deny' }
  | { kind: 'branchGate'; choice: 'here' | 'stop' }
  | { kind: 'question'; labels: string[] };

export interface CardState {
  /** Готовые ответы по `ask.key`. */
  answers: { [key: string]: AskAnswer };
  /** Вопрос, к которому вернулись кнопкой «Изменить». */
  editing?: string;
}

export type Submission =
  | {
      kind: 'permission';
      runKey: string;
      toolUseId: string;
      behavior: 'allow' | 'deny';
      keys: string[];
    }
  | {
      kind: 'branchGate';
      runKey: string;
      toolUseId: string;
      choice: 'here' | 'stop';
      keys: string[];
    }
  | { kind: 'message'; text: string; keys: string[] };
