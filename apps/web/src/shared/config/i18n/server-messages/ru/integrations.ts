import type { IntegrationsMessageCode } from '@agentdeck/contracts/server-messages';

export const integrationsRu: Record<IntegrationsMessageCode, string> = {
  'integration-not-found': 'Интеграции «{{id}}» не существует.',
  'request-atlassian-url-missing': 'Запрос не принят: не указан адрес Atlassian ({{field}}).',
  'request-atlassian-token-missing': 'Запрос не принят: не сохранён токен Atlassian ({{field}}).',
  'request-search-text-required': 'Запрос не принят: нужен текст поиска ({{field}}).',
  'request-space-missing': 'Запрос не принят: не указано пространство ({{field}}).',
  'request-page-title-missing': 'Запрос не принят: не указан заголовок страницы ({{field}}).',
  'request-search-or-jql-required': 'Запрос не принят: нужен текст поиска или JQL ({{field}}).',
  'request-jira-project-missing': 'Запрос не принят: не указан проект Jira ({{field}}).',
  'request-issue-title-missing': 'Запрос не принят: не указан заголовок задачи ({{field}}).',
  'request-comment-empty': 'Запрос не принят: пустой комментарий ({{field}}).',
  'request-transition-missing': 'Запрос не принят: не указан переход ({{field}}).',
  'request-ci-kind-missing':
    'Запрос не принят: не выбрана система CI (github или gitlab) ({{field}}).',
  'request-repo-missing':
    'Запрос не принят: не указан репозиторий и его не удалось вывести из origin ({{field}}).',
  'request-forge-kind-missing':
    'Запрос не принят: не выбран вид форджа (github или gitlab) ({{field}}).',
  'request-title-missing': 'Запрос не принят: не указан заголовок ({{field}}).',
  'request-url-not-merge-request':
    'Запрос не принят: ссылка не похожа на запрос на слияние ({{field}}).',
  'request-project-dir-missing': 'Запрос не принят: не указан каталог проекта ({{field}}).',
  'request-run-missing': 'Запрос не принят: не указан прогон ({{field}}).',
  'request-publish-target':
    'Запрос не принят: публиковать можно в confluence или в jira ({{field}}).',
  'request-token-too-long': 'Запрос не принят: токен длиннее допустимого ({{field}}).',
  'request-testit-url-missing':
    'Запрос не принят: не указан адрес Test IT: у своей установки он у каждого свой ({{field}}).',
  'request-testit-url-scheme':
    'Запрос не принят: адрес Test IT должен начинаться с http:// или https:// ({{field}}).',
  'request-testit-project-missing': 'Запрос не принят: не указан проект Test IT ({{field}}).',
  'request-testit-no-run-id':
    'Запрос не принят: {{SYSTEM}} не вернул идентификатор рана ({{field}}).',
  'request-xray-token-pair':
    'Запрос не принят: токен Xray задаётся парой «clientId:clientSecret» через двоеточие ({{field}}).',
  'request-xray-no-key': 'Запрос не принят: Xray не выдал ключ по этой паре ({{field}}).',
  'request-jira-project-key-missing': 'Запрос не принят: не указан ключ проекта Jira ({{field}}).',
  'request-xray-refused': 'Запрос не принят: Xray отказал: {{failure}} ({{field}}).',
  'request-webhook-url-missing': 'Запрос не принят: не указан адрес вебхука ({{field}}).',
  'request-webhook-url-unparsed': 'Запрос не принят: адрес вебхука не разобрался ({{field}}).',
  'request-webhook-url-scheme':
    'Запрос не принят: адрес вебхука должен быть http или https ({{field}}).',
  'request-groupid-missing': 'Запрос не принят: не указана группа тестов ({{field}}).',
  'request-chat-id-missing': 'Запрос не принят: не указан чат для уведомлений ({{field}}).',
  'request-page-body-empty':
    'Запрос не принят: пустое тело страницы — так её не перезаписывают ({{field}}).',
  'integration-token-not-saved': 'Токен не сохранён.',
  'ci-run-no-artifacts': 'У прогона {{id}} нет артефактов.',
  'ci-no-pipelines': 'В проекте нет ни одного конвейера.',
  'publish-run-not-found': 'Прогон «{{runId}}» не найден.',
  'confluence-space-missing': 'Confluence: пространства «{{key}}» нет или к нему нет доступа.',
  'integration-timeout': '{{system}} не ответила за {{seconds}} с.',
  'integration-network': 'Нет связи с {{system}}: {{reason}}.',
  'integration-token-rejected':
    '{{system}}: токен отклонён ({{status}}). Проверьте учётные данные в настройках.',
  'integration-address-404':
    '{{system}}: адрес не найден (404) — проверьте адрес сайта и идентификаторы.',
  'integration-rate-limited': '{{system}}: слишком много запросов (429), попробуйте позже.',
  'integration-server-error': '{{system}}: сервер ответил ошибкой {{status}}.',
  'integration-request-rejected': '{{system}}: запрос отклонён ({{status}}){{tail}}.',
  'integration-not-json': '{{system}} ответила не JSON — похоже, адрес ведёт не туда.',
  'ci-artifact-file-missing': 'В артефакте нет файла «{{name}}».',
  'ci-artifact-no-xml': 'В артефакте нет ни одного XML-отчёта — укажите имя файла в настройках CI.',
  'ci-workflow-runs-missing': 'Завершённых прогонов workflow «{{workflow}}» не нашлось.',
  'ci-no-finished-runs': 'В репозитории нет ни одного завершённого прогона Actions.',
  'ci-pipeline-job-missing': 'В конвейере {{pipeline}} нет задания «{{workflow}}» с артефактами.',
  'ci-pipeline-no-artifacts': 'В конвейере {{pipeline}} ни одно задание не оставило артефактов.',
  'integration-not-connected':
    '{{title}} не подключена: включите её и сохраните токен в настройках панели.',
  'tms-not-connected':
    'Тест-менеджмент не подключён: включите его и сохраните токен в настройках панели.',
  'tms-system-not-chosen':
    'Тест-менеджмент не подключён: не выбрана система (Zephyr Scale, Xray или Test IT).',
  'tms-run-already-sending':
    'Прогон «{{runId}}» уже отправляется в тест-менеджмент — дождитесь конца отправки.',
  'integrations-bridge-script-missing':
    'Не найден скрипт переходника tools/mcp/atlassian.mjs — панель запущена не из своего репозитория.',
  'tms-run-cases-not-found':
    '{{system}}: ни один кейс прогона не найден в этом проекте — {{because}}',
};
