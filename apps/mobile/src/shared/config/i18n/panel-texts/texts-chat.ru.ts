import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и обратный
 * импорт типа замыкал бы круг. Полноту держит тип словаря у места вливания.
 */
type ChatTexts = { [C in PanelTextCode]?: string };

/**
 * Тексты действий агента над чатами: прочитать, написать, попросить разделение,
 * «работать здесь», группа чата, стоп, пульт разделения и дерева, ожидания,
 * поиск. Вливаются в `panelTextsRu` одним разворотом: общий словарь правят
 * параллельно. Русский совпадает с запасным текстом сервера (`texts-chat.ts`).
 */
export const panelTextsChatRu = {
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
} satisfies ChatTexts;
