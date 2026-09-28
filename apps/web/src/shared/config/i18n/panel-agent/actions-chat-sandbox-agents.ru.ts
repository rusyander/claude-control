/**
 * Названия действий P3 (U5c) — для карточки, ленты и следа: сессия и файлы
 * чата, редактор, песочница, агенты и эмбеддинги контура. Отдельным модулем:
 * общий словарь `actions` правят несколько задач разом, этот набор вносится
 * одной строкой-спредом.
 */
export const panelActionsChatSandboxAgentsRu = {
  continue_chat_handoff: 'Продолжить чат в новой сессии',
  restart_chat_session: 'Перезапустить сессию чата',
  list_chat_artifacts: 'Файлы чата',
  read_chat_artifact: 'Прочитать файл чата',
  delete_chat_artifact: 'Удалить файл чата',
  open_project_in_editor: 'Открыть проект в редакторе',
  list_sandbox_fixtures: 'Заготовки событий песочницы',
  sandbox_probe_hook: 'Прогнать хук в песочнице',
  sandbox_ask: 'Спросить Claude в песочнице',
  ask_contour_agent: 'Спросить агента контура',
  read_contour_agent_session: 'Сессия агента контура',
  reset_contour_agent_session: 'Сбросить сессию агента контура',
  contour_embeddings: 'Эмбеддинги контура',
};
