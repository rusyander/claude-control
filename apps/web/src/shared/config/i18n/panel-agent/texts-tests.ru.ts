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
type TestsTexts = { [C in PanelTextCode]?: string } & {
  [K in `${PanelTextCountCode}_${PanelPluralForm}`]?: string;
};

/**
 * Тексты действий агента в блоке «Тестирование» (планы, ручные прогоны,
 * эталоны, автотесты, отчёты, обвязка библиотеки). Вливаются в `panelTextsRu`
 * одним разворотом: общий словарь правят параллельно. Русский совпадает с
 * запасным текстом сервера (`texts-tests-block.ts`).
 */
export const panelTextsTestsRu = {
  'journal-read-tests-report': 'Отчёт раздела тестов',
  'journal-save-test-plan': 'Запись тест-плана',
  'summary-save-test-plan-create': 'Создать тест-план «{{title}}»',
  'summary-save-test-plan-update': 'Изменить тест-план «{{title}}»',
  'journal-delete-test-plan': 'Удаление тест-плана',
  'summary-delete-test-plan': 'Удалить тест-план «{{title}}» (прогоны по нему останутся в истории)',
  'journal-build-test-plan': 'Сборка тест-плана правилом',
  'summary-build-test-plan_one': 'Сохранить план «{{title}}»: {{count}} кейс по правилу',
  'summary-build-test-plan_few': 'Сохранить план «{{title}}»: {{count}} кейса по правилу',
  'summary-build-test-plan_many': 'Сохранить план «{{title}}»: {{count}} кейсов по правилу',
  'summary-build-test-plan_other': 'Сохранить план «{{title}}»: {{count}} кейса по правилу',
  'label-plan-recipe': 'Правило отбора',
  'value-plan-recipe-smoke': 'дым под бюджет времени',
  'value-plan-recipe-diff': 'регрессия по правкам рабочей копии',
  'value-plan-recipe-release': 'план вехи',
  'value-plan-recipe-flaky': 'нестабильные кейсы',
  'journal-start-manual-run': 'Начало ручного прогона',
  'summary-start-manual-run_one': 'Начать ручной прогон: {{count}} проход',
  'summary-start-manual-run_few': 'Начать ручной прогон: {{count}} прохода',
  'summary-start-manual-run_many': 'Начать ручной прогон: {{count}} проходов',
  'summary-start-manual-run_other': 'Начать ручной прогон: {{count}} прохода',
  'journal-record-manual-result': 'Отметка результата ручного прохода',
  'summary-record-manual-result': 'Отметить «{{title}}»: {{status}}',
  'journal-finish-manual-run': 'Завершение ручного прогона',
  'summary-finish-manual-run': 'Завершить ручной прогон: отмечено {{done}} из {{total}}',
  'journal-cancel-manual-run': 'Отмена ручного прогона',
  'summary-cancel-manual-run':
    'Бросить ручной прогон: отмечено {{done}} из {{total}}, отмеченное останется',
  'journal-attach-test-note': 'Вложение к кейсу',
  'summary-attach-test-note': 'Приложить «{{name}}» к кейсу «{{title}}»',
  'journal-accept-baseline': 'Принятие эталона',
  'summary-accept-baseline': 'Принять последний снимок эталоном кейса «{{title}}»',
  'label-baseline-diff': 'Расхождение с эталоном',
  'value-baseline-replace':
    'Прежний эталон заменяется последним снимком; вернуть его из панели нельзя',
  'journal-sync-e2e': 'Сверка автотестов с кейсами',
  'summary-sync-e2e': 'Сверить тесты папки {{dir}} с кейсами',
  'journal-run-e2e': 'Запуск автотестов',
  'summary-run-e2e-all': 'Прогнать все автотесты проекта',
  'summary-run-e2e-some_one': 'Прогнать автотест {{count}} кейса',
  'summary-run-e2e-some_few': 'Прогнать автотесты {{count}} кейсов',
  'summary-run-e2e-some_many': 'Прогнать автотесты {{count}} кейсов',
  'summary-run-e2e-some_other': 'Прогнать автотесты {{count}} кейса',
  'value-e2e-run-happens':
    'Команда автотестов выполняется на этой машине, без агента; итог ляжет в историю прогонов',
  'journal-stop-e2e': 'Остановка автотестов',
  'summary-stop-e2e': 'Остановить идущий прогон автотестов',
  'journal-save-shared-step': 'Запись общего шага',
  'summary-save-shared-step-create': 'Создать общий шаг «{{title}}»',
  'summary-save-shared-step-update': 'Изменить общий шаг «{{title}}»',
  'journal-delete-shared-step': 'Удаление общего шага',
  'summary-delete-shared-step': 'Удалить общий шаг «{{title}}»',
  'journal-save-test-environment': 'Запись окружения тестов',
  'summary-save-test-environment-create': 'Создать окружение «{{title}}»',
  'summary-save-test-environment-update': 'Изменить окружение «{{title}}»',
  'journal-delete-test-environment': 'Удаление окружения тестов',
  'summary-delete-test-environment': 'Удалить окружение «{{title}}»',
  'label-used-by-plans': 'На него ссылаются планы',
  'value-environment-secrets-go': 'Сохранённые в панели доступы стенда удаляются вместе с ним',
  'journal-save-test-schema': 'Запись своих полей и статусов',
  'summary-save-test-schema': 'Заменить свои поля и статусы кейсов проекта',
  'journal-save-test-view': 'Запись сохранённого фильтра',
  'summary-save-test-view-create': 'Сохранить фильтр «{{title}}»',
  'summary-save-test-view-update': 'Изменить фильтр «{{title}}»',
  'journal-delete-test-view': 'Удаление сохранённого фильтра',
  'summary-delete-test-view': 'Удалить фильтр «{{title}}»',
  'journal-install-test-convention': 'Соглашение о кейсах в инструкциях проекта',
  'summary-install-test-convention': 'Вписать соглашение о кейсах в инструкции проекта',
  'value-convention-install':
    'Блок соглашения дописывается в файл инструкций проекта (CLAUDE.md или AGENTS.md — какой проект уже ведёт); прежний файл сохраняется копией',
  'journal-bulk-edit-cases': 'Пакетная правка кейсов',
  'summary-bulk-edit-cases_one': 'Изменить {{count}} кейс разом',
  'summary-bulk-edit-cases_few': 'Изменить {{count}} кейса разом',
  'summary-bulk-edit-cases_many': 'Изменить {{count}} кейсов разом',
  'summary-bulk-edit-cases_other': 'Изменить {{count}} кейса разом',
  'label-bulk-action': 'Что сделать',
  'journal-bulk-delete-cases': 'Пакетное удаление кейсов',
  'summary-bulk-delete-cases_one': 'Удалить {{count}} кейс',
  'summary-bulk-delete-cases_few': 'Удалить {{count}} кейса',
  'summary-bulk-delete-cases_many': 'Удалить {{count}} кейсов',
  'summary-bulk-delete-cases_other': 'Удалить {{count}} кейса',
  'journal-draft-auto-accept': 'Приёмка черновиков сразу',
  'summary-draft-auto-accept-on': 'Принимать черновики генерации сразу, без проверки',
  'summary-draft-auto-accept-off': 'Черновики генерации снова ждут проверки человеком',
  'journal-rollback-draft': 'Отмена приёмки черновика',
  'summary-rollback-draft_one':
    'Отменить приёмку черновика: {{count}} кейс вернётся к прежнему виду',
  'summary-rollback-draft_few':
    'Отменить приёмку черновика: {{count}} кейса вернутся к прежнему виду',
  'summary-rollback-draft_many':
    'Отменить приёмку черновика: {{count}} кейсов вернутся к прежнему виду',
  'summary-rollback-draft_other':
    'Отменить приёмку черновика: {{count}} кейса вернутся к прежнему виду',
} satisfies TestsTexts;
