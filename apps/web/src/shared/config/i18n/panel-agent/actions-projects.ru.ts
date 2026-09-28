/**
 * Названия действий агента над проектом (U4a) — для карточки, ленты и следа:
 * настройки проекта, git и рабочие копии, dev-серверы и чтение кода. Отдельным
 * модулем: общий словарь `actions` правят несколько задач разом, этот набор
 * вносится одной строкой-спредом.
 */
export const panelActionsProjectsRu = {
  read_project_claude_md: 'Файл инструкций проекта',
  save_project_claude_md: 'Заменить файл инструкций проекта',
  list_project_mcp: 'MCP-серверы проекта',
  save_project_mcp_server: 'Сохранить MCP-сервер проекта',
  delete_project_mcp_server: 'Удалить MCP-сервер проекта',
  toggle_project_mcp_server: 'Включить или выключить MCP-сервер проекта',
  list_project_permissions: 'Права проекта',
  add_project_permission: 'Добавить право проекта',
  edit_project_permission: 'Изменить право проекта',
  remove_project_permission: 'Удалить право проекта',
  read_project_group_choice: 'Выбор групп в проекте',
  set_project_group_choice: 'Сменить сторону пары групп в проекте',
  git_checkout: 'Переключить ветку',
  git_create_branch: 'Создать ветку',
  git_commit: 'Закоммитить изменения',
  git_pull: 'Подтянуть коммиты',
  add_worktree: 'Завести рабочую копию',
  remove_worktree: 'Удалить рабочую копию',
  bootstrap_worktree: 'Доустановить рабочую копию',
  mirror_worktree: 'Дополнить рабочую копию локальным слоем',
  read_project_copy_settings: 'Настройки копий и разделения',
  save_project_mirror_settings: 'Сменить настройки рабочих копий',
  save_project_split_settings: 'Сменить настройки разделения',
  describe_project_runner: 'Dev-серверы проекта',
  save_project_runner_settings: 'Сменить команду или порт dev-сервера',
  set_project_runner_autostart: 'Автозапуск dev-сервера',
  start_project_runner: 'Запустить dev-сервер',
  stop_project_runner: 'Остановить dev-сервер',
  free_port: 'Освободить порт',
  list_project_files: 'Файлы проекта',
  read_project_file: 'Прочитать файл проекта',
};
