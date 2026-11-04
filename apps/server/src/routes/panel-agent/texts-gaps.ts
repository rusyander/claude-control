import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Русские тексты карточек и следа действий, закрывших пробелы реестра
 * возможностей (дорожка A, 28.09). Коды объявлены в контракте
 * (`panel-agent-texts-gaps.ts`), общий словарь сервера забирает их одним
 * разворотом — правка этого набора не переписывает чужие строки.
 */
export type GapsTextCode =
  | 'journal-read-chat-modes'
  | 'journal-read-chat-spend'
  | 'journal-list-lowered-runs'
  | 'journal-read-model-pricing'
  | 'journal-list-editors'
  | 'journal-browse-folders'
  | 'journal-read-claude-access'
  | 'journal-list-providers'
  | 'journal-read-provider-checks'
  | 'journal-jira-transitions'
  | 'journal-portability-fidelity'
  | 'journal-read-project-changes'
  | 'journal-read-worktree-bootstrap-log'
  | 'journal-read-project-local-config'
  | 'journal-draft-defect'
  | 'journal-list-test-drafts'
  | 'journal-list-default-test-groups'
  | 'journal-request-chat-handoff'
  | 'summary-request-chat-handoff'
  | 'value-handoff-request-standard'
  | 'value-handoff-request-next'
  | 'journal-run-provider-check'
  | 'summary-run-provider-check'
  | 'label-provider-check-model-call'
  | 'value-provider-check-model-call-on'
  | 'value-provider-check-model-call-off'
  | 'value-provider-check-effect'
  | 'journal-refresh-defect-states'
  | 'summary-refresh-defect-states'
  | 'label-defects-tracked'
  | 'value-refresh-defects-effect'
  | 'journal-create-e2e-folder'
  | 'summary-create-e2e-folder'
  | 'value-create-e2e-effect'
  | 'journal-remove-e2e-folder'
  | 'summary-remove-e2e-folder'
  | 'value-remove-e2e-effect';

export const GAPS_TEXTS_RU: {
  [C in GapsTextCode & PanelTextCode]: string;
} = {
  'journal-read-chat-modes': 'Режимы чата',
  'journal-read-chat-spend': 'Расход чатов за сеанс',
  'journal-list-lowered-runs': 'Понижённые прогоны',
  'journal-read-model-pricing': 'Цены моделей',
  'journal-list-editors': 'Редакторы кода',
  'journal-browse-folders': 'Обзор папок',
  'journal-read-claude-access': 'Доступ Claude Code к аккаунту',
  'journal-list-providers': 'Провайдеры',
  'journal-read-provider-checks': 'Итоги проверки провайдеров',
  'journal-jira-transitions': 'Переходы задачи Jira',
  'journal-portability-fidelity': 'Верность переноса среды',
  'journal-read-project-changes': 'Правки агента в чате',
  'journal-read-worktree-bootstrap-log': 'Лог установки рабочей копии',
  'journal-read-project-local-config': 'Собственный .claude проекта',
  'journal-draft-defect': 'Черновик дефекта',
  'journal-list-test-drafts': 'Черновики тестов',
  'journal-list-default-test-groups': 'Группы тестов по умолчанию',
  'journal-request-chat-handoff': 'Просьба закрыть этап чата',
  'summary-request-chat-handoff':
    'Попросить агента чата «{{chat}}» закрыть этап и подготовить продолжение в новой сессии',
  'value-handoff-request-standard':
    'Стандартная просьба кнопки «Закрыть этап»: подвести итог и подготовить продолжение',
  'value-handoff-request-next':
    'Агент чата ответит блоком продолжения; перейти в новую сессию решаете вы (или агент панели по вашей просьбе — отдельной карточкой)',
  'journal-run-provider-check': 'Проверка провайдера',
  'summary-run-provider-check': 'Проверить провайдера «{{name}}» на этой машине',
  'label-provider-check-model-call': 'Вызов модели',
  'value-provider-check-model-call-on': 'Да — один короткий вызов, тратит лимит подписки',
  'value-provider-check-model-call-off': 'Нет — только CLI, файлы и настройки',
  'value-provider-check-effect':
    'Запись и чтение проверяются на временной копии; ваши файлы не меняются, итог сохраняется бейджем',
  'journal-refresh-defect-states': 'Обновление статусов дефектов',
  'summary-refresh-defect-states': 'Обновить статусы дефектов проекта «{{name}}» из трекера',
  'label-defects-tracked': 'Дефектов у кейсов',
  'value-refresh-defects-effect':
    'Панель читает статусы задач в трекере и записывает их у кейсов; в трекере ничего не меняется',
  'journal-create-e2e-folder': 'Папка e2e',
  'summary-create-e2e-folder': 'Завести папку e2e в проекте «{{name}}»',
  'value-create-e2e-effect':
    'Панель создаёт заготовку Playwright e2e/, скрытую от git через .git/info/exclude; своя папка проекта не трогается',
  'journal-remove-e2e-folder': 'Удаление папки e2e',
  'summary-remove-e2e-folder': 'Убрать папку e2e, заведённую панелью в проекте «{{name}}»',
  'value-remove-e2e-effect':
    'Папка удаляется целиком; если в ней есть чужие файлы, панель откажет — удалить вместе с ними может только человек',
};
