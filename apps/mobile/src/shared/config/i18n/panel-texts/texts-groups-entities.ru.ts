import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Тексты действий агента над группами по областям и над сущностями глубже
 * списка (переименование скилла, перенос хука/переменной/права, правка права,
 * связь и инструменты MCP, файлы и заготовки скилла). Вливаются в
 * `panelTextsRu` одним разворотом: общий словарь правят параллельно. Русский
 * совпадает с запасным текстом сервера (`texts-groups-entities.ts`).
 */
export const panelTextsGroupsEntitiesRu = {
  'journal-list-discovered-groups': 'Найденные наборы ресурсов',
  'journal-run-group-discovery': 'Поиск наборов ресурсов',
  'journal-import-discovered-group': 'Импорт найденного набора в группу',
  'journal-copy-group-to-global': 'Копия группы проекта в общие',
  'journal-apply-group-advice': 'Применение советов к копии группы',
  'journal-merge-group-origin': 'Слияние копии группы с оригиналом',
  'journal-read-group-override': 'Переопределение группы в проекте',
  'journal-set-group-override': 'Включение или выключение переопределения группы',
  'journal-activate-groups': 'Включение групп, привязанных к каталогу',
  'journal-list-resource-catalog': 'Каталог готовых ресурсов для групп',
  'journal-draft-group-step': 'Черновик шага пути от ассистента',
  'journal-promote-group-step': 'Шаг пути становится ресурсом',
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
  'summary-run-group-discovery':
    'Найти наборы ресурсов в проектах и каталогах CLI (источников: {{sources}})',
  'summary-import-discovered-group': 'Сделать найденный набор «{{name}}» группой проекта',
  'summary-copy-group-to-global': 'Скопировать группу «{{name}}» в общие',
  'summary-apply-group-advice': 'Применить советы к общей копии «{{name}}»',
  'summary-merge-group-origin': 'Предложить слияние копии «{{name}}» с ушедшим вперёд оригиналом',
  'summary-group-override-on': 'Включить переопределение группы «{{name}}» в проекте',
  'summary-group-override-off': 'Выключить переопределение группы «{{name}}» в проекте',
  'summary-activate-groups': 'Включить группы, привязанные к {{path}}',
  'summary-promote-group-step': 'Сделать шаг «{{step}}» отдельным ресурсом',
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
  'label-found-in': 'Где найден',
  'label-advice-items': 'Советы к применению',
  'label-resource-type': 'Вид ресурса',
  'label-target-file': 'Куда',
  'label-hook-order': 'Порядок хуков события',
  'label-template-files': 'Файлы заготовки',
  'value-happens-discovery':
    'Модель читает опись каждого источника — это тратит лимит; ваши файлы не меняются, итог виден в «Группах»',
  'value-happens-copy-global':
    'Участники копируются в общие каталоги (занятое имя получает суффикс), затем модель даёт советы — это тратит лимит',
  'value-happens-merge':
    'Модель сравнивает копию с оригиналом и предлагает правки — это тратит лимит; файлы меняются только после «Применить советы»',
  'value-happens-override-on':
    'Модель пишет правило {{file}} в проекте (скрыто от git), общие скиллы группы в проекте запрещаются',
  'value-happens-override-off': 'Файл {{file}} и запреты панели убираются — проект как был',
  'value-happens-activate': 'Привязанные группы только включаются; включённые остаются как есть',
  'value-happens-mcp-spawn':
    'Панель запускает сервер (или обращается к его адресу) и говорит с ним по протоколу MCP',
  'value-happens-template':
    'Существующие файлы скилла не трогаются — добавляются только недостающие',
  'value-import-left-out': 'Не войдут: {{members}}',
  'summary-draft-group-step': 'Спросить ассистента шага пути группы «{{group}}»',
  'value-happens-draft-step':
    'Модель составляет шаг по вашим словам — это тратит лимит; группа не меняется, разговор ассистента сохраняется в данных панели, как у кнопки «Ассистент»',
} satisfies Partial<Record<PanelTextCode, string>>;
