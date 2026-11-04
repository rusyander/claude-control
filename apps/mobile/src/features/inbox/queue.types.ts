import type { CorePermitAsk } from '@agentdeck/contracts/chat-handoff';

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
  { kind: 'permission'; behavior: 'allow' | 'deny' } | { kind: 'question'; labels: string[] };

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
      /**
       * Вопрос права задачи ядра: грант и ответ — подписанными командами ядра, а не маршрутом
       * прогона (тот отвечает `core_permit_browser_only`). Ключ прогона не нужен.
       */
      kind: 'corePermit';
      card: CorePermitAsk;
      behavior: 'allow' | 'deny';
      keys: string[];
    }
  | { kind: 'message'; text: string; keys: string[] };
