/**
 * Коды текстов карточки и следа для действий P3: продолжение чата в чистой
 * сессии (блок агента и «Перезапустить сессию»), файлы чата, «Открыть в
 * редакторе», песочница (прогон хука, вопрос Claude) и агенты с эмбеддингами
 * контура.
 *
 * Отдельным модулем по той же причине, что соседние `panel-agent-texts-*`:
 * общий `panelTextParams` правят несколько наборов действий, каждый вносит свой
 * одной строкой-спредом. Модуль без импортов — его читают сервер без сборки,
 * Metro телефона и переходник. Подстановки `count` здесь нет намеренно: формы
 * числа не нужны ни одной строке набора.
 */
export const CHAT_SANDBOX_AGENTS_TEXT_PARAMS = {
  // Чат: продолжение, файлы, редактор.
  'journal-continue-chat-handoff': [],
  'journal-restart-chat-session': [],
  'journal-list-chat-artifacts': [],
  'journal-read-chat-artifact': [],
  'journal-delete-chat-artifact': [],
  'journal-open-in-editor': [],
  'summary-continue-chat-handoff': ['title'],
  'summary-restart-chat-session': ['title'],
  'summary-delete-chat-artifact': ['name', 'title'],
  'summary-open-in-editor': ['name'],
  'label-handoff-done': [],
  'label-handoff-next': [],
  'label-handoff-checkpoint': [],
  'label-artifact-size': [],
  'label-editor': [],
  'value-restart-how': ['checkpoint'],
  // Песочница.
  'journal-list-sandbox-fixtures': [],
  'journal-sandbox-probe-hook': [],
  'journal-sandbox-ask': [],
  'summary-sandbox-probe-hook': ['name'],
  'summary-sandbox-ask': [],
  'label-sandbox-events': [],
  'label-sandbox-question': [],
  'label-sandbox-rules': [],
  'label-sandbox-skills': [],
  'label-sandbox-hooks': [],
  'label-sandbox-mcp': [],
  'label-sandbox-scripts': [],
  'label-sandbox-draft-rule': [],
  'value-sandbox-events-all': [],
  'value-sandbox-cleanup': [],
  'value-sandbox-empty': [],
  'value-sandbox-ask-how': [],
  // Агенты и эмбеддинги контура.
  'journal-ask-contour-agent': [],
  'journal-read-contour-agent-session': [],
  'journal-reset-contour-agent-session': [],
  'journal-contour-embeddings': [],
  'summary-ask-contour-agent': ['name', 'title'],
  'summary-reset-contour-agent-session': ['name', 'title'],
  'summary-contour-embeddings': ['name', 'title'],
  'label-contour-agent': [],
  'label-contour-question': [],
  'label-contour-session': [],
  'label-contour-model': [],
  'label-contour-texts': [],
  'value-contour-session-none': [],
  'value-contour-agent-spends': [],
  'value-contour-session-forget': [],
  'value-contour-embeddings-spend': [],
} as const satisfies Record<string, readonly string[]>;
