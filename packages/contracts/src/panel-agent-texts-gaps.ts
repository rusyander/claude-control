/**
 * Коды текстов карточки и следа для действий, закрывших пробелы реестра
 * возможностей (дорожка A, 28.09): режимы чата и расход, подбор модели под
 * задачу, понижённые прогоны, пересечения и приёмка групп разделения, прайс,
 * редакторы, обзор папок, доступ к аккаунту, провайдеры и их проверка,
 * переходы Jira, верность переноса, краткое описание ресурса, правки агента в
 * чате, лог установки копии, собственный `.claude` проекта, дефекты, черновики
 * и папка e2e раздела «Тесты».
 *
 * Отдельным модулем по той же причине, что соседние `panel-agent-texts-*`:
 * общий `panelTextParams` правят несколько наборов действий, каждый вносит свой
 * одной строкой-спредом. Модуль без импортов — его читают сервер без сборки,
 * Metro телефона и переходник. Подстановки `count` нет намеренно: формы числа
 * ни одной строке набора не нужны.
 */
export const GAPS_TEXT_PARAMS = {
  // Чтения: строка следа.
  'journal-read-chat-modes': [],
  'journal-read-chat-spend': [],
  'journal-read-model-cascade': [],
  'journal-list-lowered-runs': [],
  'journal-read-split-overlap': [],
  'journal-read-model-pricing': [],
  'journal-list-editors': [],
  'journal-browse-folders': [],
  'journal-read-claude-access': [],
  'journal-list-providers': [],
  'journal-read-provider-checks': [],
  'journal-jira-transitions': [],
  'journal-portability-fidelity': [],
  'journal-read-project-changes': [],
  'journal-read-worktree-bootstrap-log': [],
  'journal-read-project-local-config': [],
  'journal-draft-defect': [],
  'journal-list-test-drafts': [],
  'journal-list-default-test-groups': [],
  // Правки: название следа, сводка карточки, строки карточки.
  'journal-request-chat-handoff': [],
  'summary-request-chat-handoff': ['chat'],
  'value-handoff-request-standard': [],
  'value-handoff-request-next': [],
  'journal-set-model-cascade': [],
  'summary-set-model-cascade-on': ['name'],
  'summary-set-model-cascade-off': ['name'],
  'value-model-cascade-on': [],
  'value-model-cascade-off': [],
  'journal-split-accept-group': [],
  'summary-split-accept': ['chat', 'group'],
  'summary-split-unaccept': ['chat', 'group'],
  'value-split-accept-effect': [],
  'value-split-unaccept-effect': [],
  'journal-split-resume-interrupted': [],
  'summary-split-resume-interrupted': ['chat'],
  'label-split-interrupted-groups': [],
  'value-split-resume-interrupted-effect': [],
  'journal-run-provider-check': [],
  'summary-run-provider-check': ['name'],
  'label-provider-check-model-call': [],
  'value-provider-check-model-call-on': [],
  'value-provider-check-model-call-off': [],
  'value-provider-check-effect': [],
  'journal-summarize-resource': [],
  'summary-summarize-resource': ['name'],
  'label-resource-kind': [],
  'value-summarize-resource-effect': [],
  'journal-refresh-defect-states': [],
  'summary-refresh-defect-states': ['name'],
  'label-defects-tracked': [],
  'value-refresh-defects-effect': [],
  'journal-create-e2e-folder': [],
  'summary-create-e2e-folder': ['name'],
  'value-create-e2e-effect': [],
  'journal-remove-e2e-folder': [],
  'summary-remove-e2e-folder': ['name'],
  'value-remove-e2e-effect': [],
} as const satisfies Record<string, readonly string[]>;
