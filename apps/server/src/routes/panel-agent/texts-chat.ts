import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ts`: тот вливает этот модуль, и обратный
 * импорт типа замыкал бы круг (`pnpm depcruise`, no-circular). Полноту держит
 * тип словаря у места вливания.
 */
type ChatTexts = Record<PanelTextCode, string>;

/**
 * Русские тексты карточек и следа действий над чатами (U1). Коды объявлены в
 * контракте (`panelTextParams`), общий словарь сервера забирает их одним
 * разворотом — так правка этого набора не переписывает чужие строки
 * `PANEL_TEXTS_RU`.
 */
export type ChatTextCode =
  | 'journal-read-chat'
  | 'journal-search-chats'
  | 'journal-list-waiting'
  | 'journal-list-chat-projects'
  | 'journal-send-chat-message'
  | 'journal-stop-chat-run'
  | 'journal-split-control'
  | 'summary-send-chat-message'
  | 'summary-stop-chat-run'
  | 'summary-tree-pause'
  | 'summary-tree-resume'
  | 'label-chat'
  | 'label-message'
  | 'label-effort'
  | 'label-chat-state'
  | 'value-chat-busy-queued'
  | 'value-chat-idle'
  | 'value-stop-run'
  | 'value-tree-pause-effect'
  | 'value-tree-resume-effect';

export const CHAT_TEXTS_RU: Pick<ChatTexts, ChatTextCode> = {
  'journal-read-chat': 'Чтение чата',
  'journal-search-chats': 'Поиск по чатам',
  'journal-list-waiting': 'Что в чатах ждёт человека',
  'journal-list-chat-projects': 'Папки, в которых есть чаты',
  'journal-send-chat-message': 'Сообщение в чат',
  'journal-stop-chat-run': 'Остановка агента в чате',
  'journal-split-control': 'Управление разделением задач',
  'summary-send-chat-message': 'Отправить сообщение в чат «{{chat}}»',
  'summary-stop-chat-run': 'Остановить агента в чате «{{chat}}»',
  'summary-tree-pause': 'Остановить всё дерево чата «{{chat}}»',
  'summary-tree-resume': 'Продолжить всё дерево чата «{{chat}}»',
  'label-chat': 'Чат',
  'label-message': 'Сообщение',
  'label-effort': 'Глубина продумывания',
  'label-chat-state': 'Агент чата',
  'value-chat-busy-queued': 'Сейчас работает — сообщение уйдёт, когда он закончит ход',
  'value-chat-idle': 'Свободен — сообщение уйдёт сразу',
  'value-stop-run': 'Ход прервётся; начатое агент не доделает',
  'value-tree-pause-effect': 'Остановятся все прогоны этой просьбы, автостарты замрут',
  'value-tree-resume-effect': 'Остановленные разговоры продолжатся, отложенное уйдёт',
};
