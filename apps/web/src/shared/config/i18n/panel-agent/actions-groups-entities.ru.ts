/**
 * Названия действий агента над группами по областям и над сущностями глубже
 * списка (U5a) — для карточки, ленты и следа. Отдельным модулем: общий словарь
 * `actions` правят несколько задач разом, этот набор вносится одной строкой-спредом.
 */
export const panelActionsGroupsEntitiesRu = {
  list_discovered_groups: 'Найденные наборы ресурсов',
  run_group_discovery: 'Искать наборы ресурсов заново',
  import_discovered_group: 'Сделать находку группой',
  copy_group_to_global: 'Скопировать группу в общие',
  apply_group_advice: 'Применить советы к копии группы',
  merge_group_origin: 'Слить копию группы с оригиналом',
  read_group_override: 'Переопределение группы в проекте',
  set_group_override: 'Включить или выключить переопределение группы',
  activate_groups_for_path: 'Включить группы папки',
  list_resource_catalog: 'Каталог готовых ресурсов',
  draft_group_step: 'Черновик шага пути',
  promote_group_step: 'Шаг пути — в отдельный ресурс',
  rename_skill: 'Переименовать скилл',
  move_hook: 'Переставить хук',
  move_env: 'Перенести переменную в другой файл',
  move_permission: 'Перенести право в другой файл',
  edit_permission_rule: 'Поправить право',
  check_mcp_health: 'Проверить связь с MCP-сервером',
  list_mcp_tools: 'Инструменты MCP-сервера',
  list_skill_templates: 'Заготовки структуры скилла',
  apply_skill_template: 'Добавить заготовку в скилл',
  list_skill_files: 'Файлы скилла',
  read_skill_file: 'Прочитать файл скилла',
  save_skill_file: 'Записать файл скилла',
  delete_skill_file: 'Удалить файл скилла',
  move_skill_file: 'Переместить файл скилла',
};
