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
  'journal-request-split': [],
  'journal-split-decline': [],
  'journal-set-chat-group': [],
  'journal-stop-chat-run': [],
  'journal-split-control': [],
  // Сводки карточек.
  'summary-send-chat-message': ['chat'],
  'summary-request-split': ['chat'],
  'summary-split-decline': ['chat'],
  'summary-set-chat-group': ['chat'],
  'summary-stop-chat-run': ['chat'],
  'summary-split-pause': ['chat', 'group'],
  'summary-split-resume': ['chat', 'group'],
  'summary-split-release': ['chat', 'group'],
  'summary-split-answer': ['chat', 'group'],
  'summary-tree-pause': ['chat'],
  'summary-tree-resume': ['chat'],
  // Поля карточек.
  'label-chat': [],
  'label-message': [],
  'label-effort': [],
  'label-chat-state': [],
  'label-autonomous': [],
  'label-answer': [],
  'label-question': [],
  'value-split-request-standard': [],
  'value-split-next-human': [],
  'value-chat-busy-queued': [],
  'value-chat-idle': [],
  'value-group-auto': [],
  'value-group-inherit': [],
  'value-autonomous-on': [],
  'value-autonomous-off': [],
  'value-autonomous-inherit': [],
  'value-stop-run': [],
  'value-stop-pauses-group': [],
  'value-split-decline-effect': [],
  'value-split-pause-effect': [],
  'value-split-resume-effect': [],
  'value-split-requeue-effect': [],
  'value-split-resume-fresh-effect': [],
  'value-split-pause-queued-effect': [],
  'value-split-release-effect': [],
  'value-split-answer-effect': [],
  'value-tree-pause-effect': [],
  'value-tree-resume-effect': [],
} as const satisfies Record<string, readonly string[]>;
