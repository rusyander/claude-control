/**
 * Названия действий, закрывших пробелы реестра возможностей агента (дорожка A,
 * 28.09) — для карточки, ленты и следа. Отдельным модулем: общий словарь
 * `actions` правят несколько задач разом, этот набор вносится одной
 * строкой-спредом.
 */
export const panelActionsGapsRu = {
  read_chat_modes: 'Режимы чата',
  read_chat_spend: 'Расход чатов за сеанс',
  request_chat_handoff: 'Попросить чат закрыть этап',
  read_model_cascade: 'Подбор модели под задачу',
  set_model_cascade: 'Включить или выключить подбор модели',
  list_lowered_runs: 'Понижённые прогоны',
  read_split_overlap: 'Пересечения веток разделения',
  split_accept_group: 'Принять группу разделения',
  split_resume_interrupted: 'Продолжить оборванные группы',
  read_model_pricing: 'Цены моделей',
  list_editors: 'Редакторы кода',
  read_claude_access: 'Доступ к аккаунту',
  browse_folders: 'Обзор папок',
  list_providers: 'Провайдеры',
  read_provider_checks: 'Итоги проверки провайдеров',
  run_provider_check: 'Проверить провайдера',
  jira_transitions: 'Переходы задачи Jira',
  portability_fidelity: 'Верность переноса среды',
  summarize_resource: 'Кратко описать ресурс',
  read_project_changes: 'Правки агента в чате',
  read_worktree_bootstrap_log: 'Лог установки копии',
  read_project_local_config: 'Собственный .claude проекта',
  draft_defect: 'Черновик дефекта',
  refresh_defect_states: 'Обновить статусы дефектов',
  list_test_drafts: 'Черновики тестов',
  create_e2e_folder: 'Завести папку e2e',
  remove_e2e_folder: 'Убрать папку e2e',
  list_default_test_groups: 'Группы тестов по умолчанию',
};
