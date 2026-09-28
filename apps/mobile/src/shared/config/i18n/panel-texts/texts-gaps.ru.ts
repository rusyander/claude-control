import type {
  PanelPluralForm,
  PanelTextCode,
  PanelTextCountCode,
} from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и
 * обратный импорт типа замыкал бы круг (`pnpm depcruise`, no-circular). Полноту
 * держит тип `PanelTextDictionary` у места вливания.
 */
type GapsTexts = { [C in PanelTextCode]?: string } & {
  [K in `${PanelTextCountCode}_${PanelPluralForm}`]?: string;
};

/**
 * Тексты действий, закрывших пробелы реестра возможностей агента (дорожка A,
 * 28.09): режимы и расход чата, подбор модели, разделение, настройки,
 * провайдеры, проект и раздел «Тесты». Вливаются в `panelTextsRu` одним
 * разворотом. Русский совпадает с запасным текстом сервера (`texts-gaps.ts`).
 */
export const panelTextsGapsRu = {
  'journal-read-chat-modes': 'Режимы чата',
  'journal-read-chat-spend': 'Расход чатов за сеанс',
  'journal-read-model-cascade': 'Подбор модели под задачу',
  'journal-list-lowered-runs': 'Понижённые прогоны',
  'journal-read-split-overlap': 'Пересечения веток разделения',
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
  'journal-set-model-cascade': 'Подбор модели под задачу',
  'summary-set-model-cascade-on': 'Включить подбор модели под задачу в проекте «{{name}}»',
  'summary-set-model-cascade-off': 'Выключить подбор модели под задачу в проекте «{{name}}»',
  'value-model-cascade-on':
    'Следующие прогоны чатов этого проекта (и его копий) сами выбирают модель под род работы',
  'value-model-cascade-off':
    'Следующие прогоны чатов этого проекта (и его копий) идут на выбранной вами модели',
  'journal-split-accept-group': 'Приёмка группы разделения',
  'summary-split-accept': 'Принять доставленную группу «{{group}}» разделения чата «{{chat}}»',
  'summary-split-unaccept':
    'Снять отметку «принято» с группы «{{group}}» разделения чата «{{chat}}»',
  'value-split-accept-effect':
    'Группа получает отметку «принято» в плане разделения; её ветка, копия и чат не меняются',
  'value-split-unaccept-effect':
    'Отметка «принято» снимается; ветка, копия и чат группы не меняются',
  'journal-split-resume-interrupted': 'Продолжение оборванных групп разделения',
  'summary-split-resume-interrupted': 'Продолжить оборванные группы разделения чата «{{chat}}»',
  'label-split-interrupted-groups': 'Оборванные группы',
  'value-split-resume-interrupted-effect':
    'Каждая группа продолжается своей сессией с восстановлением состояния; ход тратит лимит подписки',
  'journal-run-provider-check': 'Проверка провайдера',
  'summary-run-provider-check': 'Проверить провайдера «{{name}}» на этой машине',
  'label-provider-check-model-call': 'Вызов модели',
  'value-provider-check-model-call-on': 'Да — один короткий вызов, тратит лимит подписки',
  'value-provider-check-model-call-off': 'Нет — только CLI, файлы и настройки',
  'value-provider-check-effect':
    'Запись и чтение проверяются на временной копии; ваши файлы не меняются, итог сохраняется бейджем',
  'journal-summarize-resource': 'Краткое описание ресурса',
  'summary-summarize-resource': 'Описать «{{name}}» коротко',
  'label-resource-kind': 'Вид ресурса',
  'value-summarize-resource-effect':
    'Если описания ещё нет, панель один раз зовёт дешёвую модель (тратит лимит) и запоминает ответ',
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
} satisfies GapsTexts;
