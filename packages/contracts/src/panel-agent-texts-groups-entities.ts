/**
 * Коды текстов карточки и следа для действий агента над группами по областям
 * (обнаружение, копия в общие, советы, слияние, переопределение, включение по
 * каталогу, «Путь» → ресурс) и над сущностями глубже списка (переименование
 * скилла, перенос хука/переменной/права, правка права, связь и инструменты MCP,
 * файлы и заготовки структуры скилла).
 *
 * Отдельным модулем, а не строками в `panelTextParams`: действия разных полос
 * пишутся параллельно, и общий литерал получает одну строку-подмешивание. Без
 * внешних импортов — модуль уходит в бандл телефона вместе с `panel-agent`.
 */
export const GROUPS_ENTITIES_TEXT_PARAMS = {
  // След: строка чтения и название правки.
  'journal-rename-skill': [],
  'journal-move-hook': [],
  'journal-move-env': [],
  'journal-move-permission': [],
  'journal-edit-permission': [],
  'journal-check-mcp-health': [],
  'journal-list-mcp-tools': [],
  'journal-list-skill-templates': [],
  'journal-apply-skill-template': [],
  'journal-list-skill-files': [],
  'journal-read-skill-file': [],
  'journal-save-skill-file': [],
  'journal-delete-skill-file': [],
  'journal-move-skill-file': [],
  // Сводки карточек.
  'summary-rename-skill': ['from', 'to'],
  'summary-move-hook-up': ['event'],
  'summary-move-hook-down': ['event'],
  'summary-move-env': ['key', 'to'],
  'summary-move-permission': ['pattern', 'to'],
  'summary-edit-permission': ['pattern'],
  'summary-check-mcp-health': ['name'],
  'summary-list-mcp-tools': ['name'],
  'summary-apply-skill-template': ['template', 'skill'],
  'summary-save-skill-file-create': ['file', 'skill'],
  'summary-save-skill-file-update': ['file', 'skill'],
  'summary-delete-skill-file': ['file', 'skill'],
  'summary-move-skill-file': ['from', 'to', 'skill'],
  // Подписи и значения полей карточки.
  'label-target-file': [],
  'label-hook-order': [],
  'label-template-files': [],
  'value-happens-mcp-spawn': [],
  'value-happens-template': [],
} as const satisfies Record<string, readonly string[]>;
