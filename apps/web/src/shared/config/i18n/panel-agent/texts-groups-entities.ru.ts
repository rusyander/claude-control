import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Тексты действий агента над группами по областям и над сущностями глубже
 * списка (переименование скилла, перенос хука/переменной/права, правка права,
 * связь и инструменты MCP, файлы и заготовки скилла). Вливаются в
 * `panelTextsRu` одним разворотом: общий словарь правят параллельно. Русский
 * совпадает с запасным текстом сервера (`texts-groups-entities.ts`).
 */
export const panelTextsGroupsEntitiesRu = {
  'journal-rename-skill': 'Переименование скилла',
  'journal-move-hook': 'Перестановка хука',
  'journal-move-env': 'Перенос переменной окружения в другой файл',
  'journal-move-permission': 'Перенос права в другой файл',
  'journal-edit-permission': 'Правка права',
  'journal-check-mcp-health': 'Проверка связи с MCP-сервером',
  'journal-list-mcp-tools': 'Инструменты MCP-сервера',
  'journal-list-skill-templates': 'Заготовки структуры скилла',
  'journal-apply-skill-template': 'Заготовка структуры в скилл',
  'journal-list-skill-files': 'Файлы скилла',
  'journal-read-skill-file': 'Файл скилла',
  'journal-save-skill-file': 'Запись файла скилла',
  'journal-delete-skill-file': 'Удаление файла скилла',
  'journal-move-skill-file': 'Перенос файла внутри скилла',
  'summary-rename-skill': 'Переименовать скилл «{{from}}» в «{{to}}»',
  'summary-move-hook-up': 'Поднять хук события {{event}} на одно место выше',
  'summary-move-hook-down': 'Опустить хук события {{event}} на одно место ниже',
  'summary-move-env': 'Перенести переменную {{key}} в {{to}}',
  'summary-move-permission': 'Перенести право {{pattern}} в {{to}}',
  'summary-edit-permission': 'Изменить право {{pattern}}',
  'summary-check-mcp-health': 'Проверить связь с MCP-сервером «{{name}}»',
  'summary-list-mcp-tools': 'Запросить список инструментов MCP-сервера «{{name}}»',
  'summary-apply-skill-template': 'Добавить в скилл «{{skill}}» файлы заготовки «{{template}}»',
  'summary-save-skill-file-create': 'Создать файл {{file}} в скилле «{{skill}}»',
  'summary-save-skill-file-update': 'Изменить файл {{file}} в скилле «{{skill}}»',
  'summary-delete-skill-file': 'Удалить файл {{file}} из скилла «{{skill}}»',
  'summary-move-skill-file': 'Перенести {{from}} в {{to}} внутри скилла «{{skill}}»',
  'label-target-file': 'Куда',
  'label-hook-order': 'Порядок хуков события',
  'label-template-files': 'Файлы заготовки',
  'value-happens-mcp-spawn':
    'Панель запускает сервер (или обращается к его адресу) и говорит с ним по протоколу MCP',
  'value-happens-template':
    'Существующие файлы скилла не трогаются — добавляются только недостающие',
} satisfies Partial<Record<PanelTextCode, string>>;
