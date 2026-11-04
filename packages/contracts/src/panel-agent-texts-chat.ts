/**
 * Коды текстов карточки и следа для действий агента над чатами: прочитать чат,
 * написать в него, попросить разделение, «работать здесь», группа чата, стоп,
 * пульт разделения и дерева, ожидания человека, поиск по переписке.
 *
 * Отдельным модулем по той же причине, что соседние `panel-agent-texts-*`:
 * общий `panelTextParams` правят несколько наборов действий, каждый вносит свой
 * одной строкой-спредом. Модуль без импортов — его читают сервер без сборки,
 * Metro телефона и переходник.
 */
export const CHAT_TEXT_PARAMS = {
  // След: строки чтения и названия правок.
  'journal-read-chat': [],
  'journal-search-chats': [],
  'journal-list-waiting': [],
  'journal-list-chat-projects': [],
  'journal-send-chat-message': [],
  'journal-stop-chat-run': [],
  'journal-split-control': [],
  // Сводки карточек.
  'summary-send-chat-message': ['chat'],
  'summary-stop-chat-run': ['chat'],
  'summary-tree-pause': ['chat'],
  'summary-tree-resume': ['chat'],
  // Поля карточек.
  'label-chat': [],
  'label-message': [],
  'label-effort': [],
  'label-chat-state': [],
  'value-chat-busy-queued': [],
  'value-chat-idle': [],
  'value-stop-run': [],
  'value-tree-pause-effect': [],
  'value-tree-resume-effect': [],
} as const satisfies Record<string, readonly string[]>;
