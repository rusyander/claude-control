import type { PlatformMessageCode } from '@agentdeck/contracts/server-messages';

export const platformRu: Record<PlatformMessageCode, string> = {
  'capability-models-key-scoped': 'список сужен правами ключа',
  'capability-models-gateway-listed': 'список отдан шлюзом',
  'capability-kind-undeclared': 'вид моделей не объявлен',
  'capability-chat-listed': 'модели чата в списке ключа',
  'capability-chat-none': 'моделей чата ключу не выдано',
  'capability-embeddings-listed': 'модели эмбеддингов в списке ключа',
  'capability-embeddings-none': 'моделей эмбеддингов ключу не выдано',
  'capability-agents-call-only': 'проверяется только вызовом агента — панель его не делает',
  'capability-guardrails-in-band': 'работают в полосе запроса: отказ приходит статусом 451',
  'capability-knowledge-via-owner': 'через владельца ключа, отдельного маршрута нет',
  'capability-client-tools-rejected': 'публичный API не принимает описания инструментов',
  'capability-undeclared-by-gateway': 'совместимый шлюз этого о себе не сообщает',
  'capability-image-flag-undeclared': 'флаг рисования не объявлен ни одной моделью',
  'capability-image-no-models': 'моделей ключу не выдано',
  'capability-image-listed': 'модели с флагом рисования в списке ключа',
  'capability-image-none': 'рисующих моделей ключу не выдано',
  'platform-not-found': 'Контура «{{id}}» не существует.',
  'platform-not-connected': 'Контур «{{title}}» не подключён: включите его и сохраните ключ.',
  'platform-agents-not-declared':
    'У контура «{{title}}» нет опубликованных агентов: его тип их не объявляет.',
  'gateway-not-started': 'Шлюз не поднялся',
  'request-target-unknown': 'Запрос не принят: панель не знает цели «{{targetId}}» ({{field}}).',
  'request-ca-unreadable':
    'Запрос не принят: корневой сертификат не прочитан: {{reason}} ({{field}}).',
  'request-ca-not-certificate':
    'Запрос не принят: файл прочитан, но это не сертификат: нужен корневой сертификат компании (PEM или DER) ({{field}}).',
  'request-key-too-long': 'Запрос не принят: ключ длиннее допустимого ({{field}}).',
  'request-key-too-short':
    'Запрос не принят: ключ короче {{MIN_KEY_LENGTH}} символов — это не ключ контура ({{field}}).',
  'request-key-non-latin':
    'Запрос не принят: в ключе есть символы вне латиницы — такой ключ не уйдёт в заголовке запроса ({{field}}).',
  'request-id-mismatch':
    'Запрос не принят: идентификатор в адресе («{{id}}») и в теле («{{bodyId}}») не совпадают ({{field}}).',
  'request-key-not-string': 'Запрос не принят: ключ должен быть строкой ({{field}}).',
  'request-model-not-string': 'Запрос не принят: модель должна быть строкой ({{field}}).',
  'request-agent-missing': 'Запрос не принят: не назван агент ({{field}}).',
  'request-embedding-model-missing': 'Запрос не принят: не названа модель эмбеддингов ({{field}}).',
  'request-target-list-expected':
    'Запрос не принят: ожидается список идентификаторов целей ({{field}}).',
  'request-string-expected': 'Запрос не принят: ожидается строка ({{field}}).',
  'request-question-empty': 'Запрос не принят: вопрос пустой ({{field}}).',
  'request-question-or-messages':
    'Запрос не принят: нужен вопрос (message) или переписка (messages) ({{field}}).',
  'request-role-invalid': 'Запрос не принят: роль бывает user, assistant или system ({{field}}).',
  'request-message-empty': 'Запрос не принят: сообщение пустое ({{field}}).',
  'embeddings-empty': 'Нечего считать: список текстов пуст.',
  'embeddings-model-missing': 'Не названа модель эмбеддингов.',
  'embeddings-no-vectors': 'В ответе контура нет ни одного вектора.',
  'mcp-url-missing': 'Не задан адрес',
  'mcp-url-unparsed': 'Адрес не разбирается как URL: {{url}}',
  'mcp-command-missing': 'Не задана команда запуска',
  'oauth-network-only': 'OAuth доступен только у сетевых серверов (http/sse)',
  'oauth-session-missing': 'Сессия авторизации не найдена или истекла',
  'assistant-timeout': 'Помощник не ответил за отведённое время',
  'assistant-request-invalid': 'Запрос помощнику не принят: {{detail}}',
  'assistant-empty-reply': 'Модель вернула пустой ответ.',
  'manifest-invalid-object': 'Запрос не принят: переопределения — объект полей ({{field}}).',
  'manifest-invalid-client-tools':
    'Запрос не принят: инструменты — «native» или «shim» ({{field}}).',
  'manifest-invalid-effort': 'Запрос не принят: усилие — да или нет ({{field}}).',
  'manifest-invalid-path':
    'Запрос не принят: путь ручки относительно версии: строчная латиница, цифры, «/», «_», «-» ({{field}}).',
  'manifest-invalid-seconds': 'Запрос не принят: целое число секунд от 0 до 3600 ({{field}}).',
  'manifest-invalid-thinking-field':
    'Запрос не принят: поле на проводе: имена через точку, не больше пяти, без служебных имён объекта ({{field}}).',
  'manifest-invalid-vendor-prefix':
    'Запрос не принят: префикс полей: строчная латиница и цифры, первая — буква, до 32 знаков ({{field}}).',
  'transport-header-token': 'Запрос не принят: «{{subject}}» — не имя заголовка HTTP ({{field}}).',
  'transport-header-line':
    'Запрос не принят: «{{subject}}» — не вида «Имя: значение» (номер строки или параметра) ({{field}}).',
  'transport-header-secret':
    'Запрос не принят: «{{subject}}» — под этим именем едет ключ, а ключ хранится зашифрованным и идёт своим полем ({{field}}).',
  'transport-header-reserved':
    'Запрос не принят: «{{subject}}» — этот заголовок панель ставит сама ({{field}}).',
  'assistant-route-refused': 'Помощник не запущен: {{reason}}',
  'assistant-provider-unsupported':
    'У {{provider}} нет ни неинтерактивного запуска, ни API — помощнику нечем ответить. Переключите активный CLI или выберите профиль «Ассистент панели»',
  'assistant-provider-unavailable':
    '{{provider}} не найден в PATH процесса панели, а ключа API нет — помощнику нечем ответить. Установите CLI или сохраните ключ',
  'assistant-contour-cli-missing':
    '{{provider}} идёт через контур, а CLI не найден в PATH процесса панели — помощник не запущен, чтобы не уйти в облако вендора мимо контура',
  'assistant-contour-gateway-down':
    'Ассистент панели идёт через контур «{{title}}», а шлюз панели не поднят — запрос не отправлен, чтобы не уйти в облако вендора. Нажмите «Поднять шлюз» на карточке контура',
  'assistant-contour-no-token':
    'Ассистент панели идёт через контур «{{title}}», а ключ контура не сохранён — шлюзу нечего подставить. Сохраните ключ на карточке контура',
  'watcher-provider-unsupported':
    'Наблюдатель разбирает сбои только через Claude Code: запуск «только чтение» описан лишь у него, а активный CLI — {{provider}}. Разбор не запущен',
  'watcher-endpoint-unsupported':
    'Ассистенту панели выбран свой эндпоинт «{{name}}» — наблюдателю пришлось бы отдать его токен процессу CLI, этого панель не делает. Разбор не запущен',
  'provider-chat-unsupported':
    'У {{provider}} нет неинтерактивного запуска — чат панели с ним не работает. Разговор не создан: переключите активный CLI',
  'analytics-provider-unsupported':
    'Аналитика читает журналы только Claude Code, Codex и Qwen Code, а активный CLI — {{provider}}. Данные Claude под ним не показываются',
  'analytics-live-foreign':
    'Процессы на машине панель опознаёт только у Claude Code, а активный CLI — {{provider}}. Список пуст, чтобы не выдавать процессы claude за его собственные',
  'groups-foreign-not-delivered':
    'Группы панели живут в настройках Claude Code, а {{provider}} их не читает — до его запусков группа не доходит',
  'plugins-provider-unsupported':
    'Раздел плагинов Claude Code работает только через claude, а активный CLI — {{provider}}. Команда не запущена',
  'sandbox-provider-unsupported':
    'Песочница запускает только Claude Code, а активный CLI — {{provider}}. Прогон не запущен',
  'assistant-api-base-unknown':
    'Адрес модельного API {{provider}} панели не известен — ключ никуда не отправлен, чтобы не уйти к чужому вендору. Установите CLI или выберите свой эндпоинт',
};
