/**
 * Шаблоны текстов, которые сервер собирает строкой (`../server-texts.ts`).
 *
 * Первая тысяча кодов приехала сюда генератором по манифесту, но ни манифеста, ни
 * генератора в дереве нет: они жили во временной папке волны и удалены намеренно
 * (повторный прогон переписал бы уже расходящиеся словари). Новый код добавляется
 * РУКАМИ и сразу в четырёх местах, иначе сборка или тест краснеют: таблица кодов
 * `packages/contracts/src/server-messages/<раздел>.ts`, шаблон здесь и обе копии
 * словаря `apps/web/src/shared/config/i18n/server-messages/{ru,en}/<раздел>.ts`.
 * Счётчик русских литералов этого файла закреплён в `server-ru-literals.pins.json`.
 */
export const serverTextTemplates = {
  'gateway-prefixed': { ru: 'AgentDeck: {{message}}', en: 'AgentDeck: {{message}}' },
  'core-absent': { ru: 'Ядро задач не запущено', en: 'The task core is not running' },
  'core-unverified': {
    ru: 'Ядро задач не подтвердило себя: запрос не отправлен',
    en: 'The task core did not prove its identity: the request was not sent',
  },
  'core-unreachable': { ru: 'Ядро задач не отвечает', en: 'The task core does not answer' },
  'core-starting': { ru: 'Ядро задач поднимается', en: 'The task core is starting' },
  'core-fault': {
    ru: 'Ядро задач не запускается: нужен перезапуск',
    en: 'The task core keeps failing to start: restart needed',
  },
  'gateway-joined': { ru: '{{message}}: {{detail}}', en: '{{message}}: {{detail}}' },
  'gateway-upstream-400': {
    ru: 'Контур не принял запрос',
    en: 'The contour did not accept the request',
  },
  'gateway-upstream-401': {
    ru: 'Контур отклонил ключ. Проверьте сам ключ и его права',
    en: 'The contour rejected the key. Check the key itself and its permissions',
  },
  'gateway-upstream-402': {
    ru: 'Контур отказал по лимиту расхода — до вызова модели',
    en: 'The contour refused on the spending limit — before calling the model',
  },
  'gateway-upstream-403': {
    ru: 'Ключу не разрешена эта модель на контуре',
    en: 'This model is not allowed for the key on the contour',
  },
  'gateway-upstream-404': {
    ru: 'Контур не знает такого маршрута',
    en: 'The contour does not know this route',
  },
  'gateway-upstream-413': {
    ru: 'Запрос больше того, что контур принимает',
    en: 'The request is larger than the contour accepts',
  },
  'gateway-upstream-422': {
    ru: 'Контур не принял форму запроса',
    en: 'The contour did not accept the shape of the request',
  },
  'gateway-upstream-429': {
    ru: 'Превышен лимит ключа на контуре (запросов или токенов в минуту)',
    en: 'The key limit on the contour is exceeded (requests or tokens per minute)',
  },
  'gateway-upstream-451': {
    ru: 'Запрос остановлен проверками содержимого на стороне контура',
    en: 'The request was stopped by content checks on the contour side',
  },
  'gateway-upstream-500': {
    ru: 'Контур ответил ошибкой на своей стороне',
    en: 'The contour answered with an error on its side',
  },
  'gateway-upstream-502': {
    ru: 'Контур не смог дозваться до модели',
    en: 'The contour could not reach the model',
  },
  'gateway-upstream-503': {
    ru: 'Контур сейчас недоступен',
    en: 'The contour is unavailable right now',
  },
  'gateway-upstream-status': {
    ru: 'Контур ответил кодом {{status}}',
    en: 'The contour answered with code {{status}}',
  },
  'gateway-retry-after': {
    ru: '{{message}}. Контур просит повторить через {{seconds}} с',
    en: '{{message}}. The contour asks to retry in {{seconds}} s',
  },
  'gateway-model-forbidden': {
    ru: 'Ключу не разрешена модель «{{model}}» на контуре — список разрешённых у ключа в админке платформы, а в разделе «Контур» видно то же самое списком моделей',
    en: "Model “{{model}}” is not allowed for the key on the contour — the key's allowed list is in the platform admin, and the Contour section shows the same as its model list",
  },
  'gateway-model-not-found': {
    ru: 'Контур ответил «не найдено» на запрос модели «{{model}}». Читается это двояко: модель убрали из контура между прогонами (в разделе «Контур» пропавшие помечены и хранят дату последней встречи) — либо адрес контура указывает не на публичный API, а, например, на админку, и тогда не найден маршрут, а не модель',
    en: 'The contour answered “not found” for model “{{model}}”. This reads two ways: the model was removed from the contour between runs (the Contour section marks vanished models and keeps the date they were last seen) — or the contour address points not at the public API but, for example, at the admin, and then the route was not found, not the model',
  },
  'gateway-key-rejected': {
    ru: 'Контур отклонил ключ, и причину он не называет. Их пять: ключ неизвестен или отозван, истёк по сроку, исчерпал свой бюджет, его владельца удалили — либо сверка владельца на стороне контура не удалась (тогда ключ в порядке, и стоит повторить). Проверьте ключ, его срок, бюджет и владельца в админке платформы',
    en: 'The contour rejected the key without naming the reason. There are five: the key is unknown or revoked, expired, spent its budget, its owner was deleted — or the owner check on the contour side failed (then the key is fine and a retry is worth it). Check the key, its expiry, budget and owner in the platform admin',
  },
  'gateway-key-budget': {
    ru: 'Исчерпан бюджет ключа — контур отказал до вызова модели. Поднять бюджет или дождаться нового периода ключа можно в админке платформы; через полминуты контур начнёт отклонять этот ключ кодом 401',
    en: "The key budget is spent — the contour refused before calling the model. Raise the budget or wait for the key's next period in the platform admin; in half a minute the contour will start rejecting this key with code 401",
  },
  'gateway-content-checks-request': {
    ru: 'Проверки контента контура остановили запрос',
    en: "The contour's content checks stopped the request",
  },
  'gateway-registry-not-ready': {
    ru: 'Контур ещё поднимается: реестр моделей не готов',
    en: 'The contour is still starting: the model registry is not ready',
  },
  'gateway-route-unknown': {
    ru: 'Шлюз ядра принимает только {{routes}} по адресу /<контур>/v1/...',
    en: 'The core gateway accepts only {{routes}} at /<contour>/v1/...',
  },
  'gateway-contour-unknown': {
    ru: 'Контур «{{id}}» в панели не заведён',
    en: 'Contour “{{id}}” is not set up in the panel',
  },
  'gateway-section-closed-chat': {
    ru: 'Раздел «Чат» закрыт для контура «{{title}}» — запрос не отправлен. Открыть раздел можно на карточке контура',
    en: 'The Chat section is closed for contour “{{title}}” — the request was not sent. Open the section on the contour card',
  },
  'gateway-section-closed-groups': {
    ru: 'Раздел «Группы» закрыт для контура «{{title}}» — запрос не отправлен. Открыть раздел можно на карточке контура',
    en: 'The Groups section is closed for contour “{{title}}” — the request was not sent. Open the section on the contour card',
  },
  'gateway-section-closed-tests': {
    ru: 'Раздел «Агент тестов» закрыт для контура «{{title}}» — запрос не отправлен. Открыть раздел можно на карточке контура',
    en: 'The Tests agent section is closed for contour “{{title}}” — the request was not sent. Open the section on the contour card',
  },
  'gateway-section-closed-assistant': {
    ru: 'Раздел «Ассистент панели» закрыт для контура «{{title}}» — запрос не отправлен. Открыть раздел можно на карточке контура',
    en: 'The Panel assistant section is closed for contour “{{title}}” — the request was not sent. Open the section on the contour card',
  },
  'gateway-section-closed-terminal': {
    ru: 'Раздел «Терминал (файлы CLI)» закрыт для контура «{{title}}» — запрос не отправлен. Открыть раздел можно на карточке контура',
    en: 'The Terminal (CLI files) section is closed for contour “{{title}}” — the request was not sent. Open the section on the contour card',
  },
  'gateway-section-closed-foreign': {
    ru: 'Чат {{cli}} закрыт для контура «{{title}}» — запрос не отправлен. Открыть раздел можно на карточке контура',
    en: 'The {{cli}} chat is closed for contour “{{title}}” — the request was not sent. Open the section on the contour card',
  },
  'gateway-section-unknown': {
    ru: 'Адрес шлюза несёт незнакомую отметку раздела — запрос не отправлен. Примените контур заново, чтобы адрес переписался',
    en: 'The gateway address carries an unknown section mark — the request was not sent. Apply the contour again to rewrite the address',
  },
  'gateway-body-too-large': {
    ru: 'Тело запроса больше 32 МБ — шлюз его не принимает',
    en: 'The request body is over 32 MB — the gateway does not accept it',
  },
  'gateway-responses-previous-id': {
    ru: 'previous_response_id шлюз не поддерживает: пришлите весь разговор в input (store: false)',
    en: 'The gateway does not support previous_response_id: send the whole conversation in input (store: false)',
  },
  'gateway-responses-not-request': {
    ru: 'Тело запроса /v1/responses без model или input — это не запрос Responses',
    en: 'A /v1/responses body without model or input is not a Responses request',
  },
  'gateway-google-not-request': {
    ru: 'Тело запроса Gemini без contents — это не запрос generateContent',
    en: 'A Gemini request body without contents is not a generateContent request',
  },
  'gateway-google-empty': {
    ru: 'В запросе Gemini нет ни одного сообщения, на которое можно ответить',
    en: 'The Gemini request has no message to answer',
  },
  'gateway-body-not-json': {
    ru: 'Тело запроса не разбирается как JSON',
    en: 'The request body does not parse as JSON',
  },
  'gateway-answer-not-model': {
    ru: 'Контур ответил не потоком, и его тело не разбирается как ответ модели',
    en: 'The contour did not answer with a stream, and its body does not parse as a model answer',
  },
  'gateway-client-gone': {
    ru: 'Клиент отключился до конца ответа',
    en: 'The client disconnected before the answer ended',
  },
  'gateway-answer-broken': {
    ru: 'Ответ контура оборвался: {{reason}}',
    en: "The contour's answer broke off: {{reason}}",
  },
  'gateway-answer-truncated': {
    ru: 'Ответ контура оборвался: поток закончился без завершающего кадра — ответ неполон',
    en: "The contour's answer broke off: the stream ended without a final frame — the answer is incomplete",
  },
  'gateway-upstream-aborted': {
    ru: 'Контур прервал ответ: {{message}}',
    en: 'The contour aborted the answer: {{message}}',
  },
  'gateway-upstream-unnamed-error': {
    ru: 'та сторона закончила ответ ошибкой и не назвала её',
    en: 'the other side ended the answer with an error and did not name it',
  },
  'gateway-checks-stopped': {
    ru: 'Проверки контента контура остановили ответ',
    en: "The contour's content checks stopped the answer",
  },
  'gateway-checks-stopped-named': {
    ru: 'Проверки контента контура остановили ответ: {{names}}',
    en: "The contour's content checks stopped the answer: {{names}}",
  },
  'gateway-tool-blocked': {
    ru: 'Вызов «{{name}}» остановлен хуком PreToolUse',
    en: 'The “{{name}}” call was stopped by the PreToolUse hook',
  },
  'gateway-tool-blocked-why': {
    ru: 'Вызов «{{name}}» остановлен хуком PreToolUse: {{reason}}',
    en: 'The “{{name}}” call was stopped by the PreToolUse hook: {{reason}}',
  },
  'wire-permission-denied': {
    ru: 'Правило прав «{{rule}}» запрещает этот вызов',
    en: 'The permission rule “{{rule}}” forbids this call',
  },
  'wire-permission-unmatchable': {
    ru: 'Правило прав «{{rule}}» уточняет аргумент, которого у вызова нет: сравнить нечем, и вызов отклонён',
    en: 'The permission rule “{{rule}}” names an argument the call does not have: there is nothing to compare, so the call is refused',
  },
  'wire-permission-ask-denied': {
    ru: 'Человек отказал по правилу прав «{{rule}}»',
    en: 'A human refused under the permission rule “{{rule}}”',
  },
  'wire-permission-ask-timeout': {
    ru: 'Правило прав «{{rule}}» требует подтверждения человека, а ответа не было',
    en: 'The permission rule “{{rule}}” needs a human confirmation, and no answer came',
  },
  'wire-permission-ask-nobody': {
    ru: 'Правило прав «{{rule}}» требует подтверждения человека, а спросить некому',
    en: 'The permission rule “{{rule}}” needs a human confirmation, and there is nobody to ask',
  },
  'gateway-answer-too-large': {
    ru: 'Ответ контура больше 8 МБ — шлюз не собирает его целиком. Тот же запрос потоком приходит без этого потолка',
    en: "The contour's answer is over 8 MB — the gateway does not assemble it whole. The same request as a stream comes without this ceiling",
  },
  'gateway-mask-rules-broken': {
    ru: 'Защита данных включена, а правила не читаются ({{error}})',
    en: 'Data protection is on, but its rules cannot be read ({{error}})',
  },
  'gateway-mask-unparsed': {
    ru: 'Защита данных не разобрала тело запроса',
    en: 'Data protection could not parse the request body',
  },
  'gateway-mask-blocked': {
    ru: 'Запрос остановлен правилом «{{rule}}» — в нём нашлись данные, которые не должны уходить в модель',
    en: 'The request was stopped by rule “{{rule}}” — it contains data that must not go to the model',
  },
  'gateway-mask-unrestorable': {
    ru: 'Вызов инструмента остановлен: метку защиты данных {{names}} нечем развернуть — она уехала бы в файл вместо значения',
    en: 'The tool call was stopped: data protection label {{names}} cannot be restored — it would go into the file instead of the value',
  },
  'gateway-images-not-declared': {
    ru: 'У контура «{{title}}» ручка картинок манифестом не объявлена',
    en: 'Contour “{{title}}” has no images endpoint declared in its manifest',
  },
  'gateway-images-too-large': {
    ru: 'Ответ ручки картинок больше 16 МБ — шлюз его не собирает',
    en: 'The images endpoint answer is over 16 MB — the gateway does not assemble it',
  },
  'gateway-ports-busy-unknown': { ru: 'причина неизвестна', en: 'reason unknown' },
  'gateway-core-unknown': {
    ru: 'ядро ещё не сказало, слушает ли шлюз контуров',
    en: 'the core has not said yet whether the contour gateway is listening',
  },
  'gateway-core-waiting': {
    ru: 'шлюз контуров у ядра ждёт порт {{port}}: {{reason}}',
    en: 'the core contour gateway is waiting for port {{port}}: {{reason}}',
  },
  'gateway-ceiling-cut': {
    ru: 'Ответ контура оборвался на {{seconds}}-й секунде — это потолок самой платформы на любой ответ, поток тоже. Сеть здесь ни при чём: сократите ход (меньше размышлений, короче ответ) или попросите владельца контура поднять потолок',
    en: "The contour's answer broke off at second {{seconds}} — that is the platform's own ceiling for any answer, streams included. The network is not to blame: shorten the turn (less thinking, a shorter answer) or ask the contour owner to raise the ceiling",
  },
  'gateway-url-not-http': {
    ru: 'Адрес контура не http(s): {{url}}',
    en: 'The contour address is not http(s): {{url}}',
  },
  'gateway-redirect': {
    ru: 'Контур ответил перенаправлением ({{status}}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет',
    en: 'The contour answered with a redirect ({{status}}) — the panel did not follow it: the request would have gone to another address. Put the address it redirects to into the contour settings',
  },
  'gateway-redirect-to': {
    ru: 'Контур ответил перенаправлением на {{where}} ({{status}}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет',
    en: 'The contour answered with a redirect to {{where}} ({{status}}) — the panel did not follow it: the request would have gone to another address. Put the address it redirects to into the contour settings',
  },
  'gateway-headers-timeout': {
    ru: 'Контур не начал отвечать за {{seconds}} с',
    en: 'The contour did not start answering within {{seconds}} s',
  },
  'gateway-headers-timeout-local': {
    ru: 'Локальная модель не начала отвечать за {{seconds}} с: длинный запрос обрабатывается дольше, чем отведено. Сожмите историю (/compact) или начните новый чат',
    en: 'The local model did not start answering within {{seconds}} s: a long prompt takes longer to process than allowed. Compact the history (/compact) or start a new chat',
  },
  'gateway-cert-failed': {
    ru: 'Сертификат контура не проверился: {{reason}}. Укажите корневой сертификат компании в настройках контура',
    en: 'The contour certificate did not verify: {{reason}}. Set the company root certificate in the contour settings',
  },
  'gateway-no-connection': {
    ru: 'Нет связи с контуром: {{reason}}',
    en: 'No connection to the contour: {{reason}}',
  },
  'gateway-key-not-header-safe': {
    ru: 'Ключ контура не годится для заголовка: в нём есть символы вне латиницы. Сохраните ключ заново, без лишних символов',
    en: 'The contour key cannot go into a header: it has characters outside Latin. Save the key again without the extra characters',
  },
  'gateway-proxy-unsupported': {
    ru: 'Прокси из {{source}} ({{value}}) панель не умеет: нужен обычный http-прокси. Напрямую в обход названного прокси панель не пойдёт',
    en: 'The panel cannot use the proxy from {{source}} ({{value}}): a plain http proxy is needed. The panel will not go direct around the named proxy',
  },
  'gateway-proxy-unreachable': {
    ru: 'прокси {{host}} недоступен: {{reason}}',
    en: 'proxy {{host}} is unreachable: {{reason}}',
  },
  'gateway-proxy-connect-timeout': {
    ru: 'прокси {{host}} не ответил на CONNECT за {{seconds}} с',
    en: 'proxy {{host}} did not answer CONNECT within {{seconds}} s',
  },
  'gateway-proxy-connect-refused': {
    ru: 'прокси {{host}} не пропустил CONNECT к {{authority}}: {{status}}',
    en: 'proxy {{host}} did not pass CONNECT to {{authority}}: {{status}}',
  },
  'gateway-proxy-connect-login': {
    ru: 'прокси {{host}} не пропустил CONNECT к {{authority}}: {{status}} (нужен логин к прокси)',
    en: 'proxy {{host}} did not pass CONNECT to {{authority}}: {{status}} (proxy login required)',
  },
  'gateway-request-cancelled': { ru: 'запрос отменён', en: 'request cancelled' },
  'gateway-flaw-fenced': {
    ru: 'вызов внутри блока кода не выполняется',
    en: 'a call inside a code block is not executed',
  },
  'gateway-flaw-loose-whole': {
    ru: 'вызов без тега принимается только целым объектом JSON',
    en: 'a call without tags is accepted only as a whole JSON object',
  },
  'gateway-flaw-undeclared': {
    ru: 'инструмент не объявлен клиентом',
    en: 'the tool is not declared by the client',
  },
  'gateway-flaw-args': {
    ru: 'аргументы не разбираются как объект',
    en: 'arguments do not parse as an object',
  },
  'gateway-flaw-empty': { ru: 'пустой блок вызова', en: 'empty call block' },
  'gateway-flaw-several': {
    ru: 'несколько вызовов в одном блоке',
    en: 'several calls in one block',
  },
  'gateway-flaw-not-json': { ru: 'не разбирается как JSON', en: 'does not parse as JSON' },
  'gateway-flaw-no-object': { ru: 'внутри блока нет объекта', en: 'no object inside the block' },
  'gateway-flaw-no-name': { ru: 'в блоке нет имени инструмента', en: 'no tool name in the block' },
  'gateway-flaw-unclosed': { ru: 'блок без закрывающего тега', en: 'block without a closing tag' },
  'gateway-flaw-fence-midanswer': {
    ru: 'вызов забором посреди ответа не выполняется',
    en: 'a fenced call in the middle of an answer is not executed',
  },
  'gateway-flaw-contour-unnamed': {
    ru: 'вызов контура без имени',
    en: 'contour call without a name',
  },
  'gateway-flaw-contour-args': {
    ru: 'аргументы вызова контура не разбираются',
    en: 'contour call arguments do not parse',
  },
  'gateway-flaw-stop-without-call': {
    ru: 'причина остановки «вызов» без единого вызова',
    en: 'stop reason “call” without a single call',
  },
  'gateway-request-aborted': { ru: 'Запрос отменён', en: 'Request cancelled' },
  'proxy-failed': {
    ru: 'прокси не смог обработать запрос',
    en: 'the proxy could not handle the request',
  },
  'proxy-body-too-large': {
    ru: 'тело запроса слишком велико',
    en: 'the request body is too large',
  },
  'proxy-shape-unknown': {
    ru: 'форма запроса не разбирается',
    en: 'the request shape does not parse',
  },
  'proxy-body-not-json': { ru: 'тело запроса не JSON', en: 'the request body is not JSON' },
  'proxy-stopped-unparsed': {
    ru: 'AgentDeck: {{reason}}, запрос остановлен (настройка «пропускать неразобранное» выключена)',
    en: 'AgentDeck: {{reason}}, the request was stopped (the “Pass through unparsed bodies” setting is off)',
  },
  'kit-compose-failed': {
    ru: 'Прогон не запущен: набор панели не собрался. Переключите режим набора на «Только ваши» или повторите',
    en: 'Run not started: the panel kit failed to build. Switch the kit mode to «Yours only» or retry',
  },
  'kit-codex-too-large': {
    ru: 'Прогон не запущен: правила и навыки набора панели для Codex — {{size}} знаков, а поле инструкций сеанса Codex вмещает не больше {{limit}}. Ничего не обрезано: выключите часть элементов набора или переключите режим набора на «Только ваши»',
    en: 'Run not started: the panel kit rules and skills for Codex take {{size}} characters, and the Codex session instructions field holds no more than {{limit}}. Nothing was trimmed: switch some kit items off or switch the kit mode to «Yours only»',
  },
  'proxy-upstream-unreachable': {
    ru: 'AgentDeck: адрес модели не отвечает ({{reason}})',
    en: 'AgentDeck: the model address does not answer ({{reason}})',
  },
  'contour-gateway-not-raised': {
    ru: 'Шлюз не поднялся: {{reason}}',
    en: 'The gateway did not start: {{reason}}',
  },
  'contour-smoke-no-models': {
    ru: 'Контур не назвал ни одной модели: спрашивать нечем.',
    en: 'The contour named no models: there is nothing to ask with.',
  },
  'contour-smoke-gateway-down': {
    ru: 'Шлюз не поднят: пробный запрос идёт через него, как и работа CLI.',
    en: 'The gateway is down: the probe request goes through it, just as the CLI does.',
  },
  'contour-smoke-thinking-cap': {
    ru: 'Модель израсходовала потолок пробного запроса ({{tokens}} токенов), не сказав ни слова, — похоже, всё ушло в размышления. Путь прошёл; у рабочих запросов потолок выше.',
    en: 'The model spent the probe ceiling ({{tokens}} tokens) without saying a word — it looks like everything went into reasoning. The path works; real requests have a higher ceiling.',
  },
  'contour-smoke-silent': {
    ru: 'Модель не сказала ни слова: путь прошёл, ответа нет.',
    en: 'The model said nothing: the path works, there is no answer.',
  },
  'contour-smoke-timeout': {
    ru: 'Ответа не было {{seconds}} с — столько же прождёт и CLI.',
    en: 'No answer for {{seconds}} s — the CLI would wait exactly as long.',
  },
  'contour-smoke-gateway-error': {
    ru: 'Шлюз не ответил: {{reason}}.',
    en: 'The gateway did not answer: {{reason}}.',
  },
  'contour-smoke-refused': {
    ru: 'Шлюз ответил {{status}}: {{message}}',
    en: 'The gateway answered {{status}}: {{message}}',
  },
  'contour-smoke-status': {
    ru: 'Шлюз ответил {{status}}.',
    en: 'The gateway answered {{status}}.',
  },
  'contour-agent-not-json': {
    ru: 'Контур ответил не JSON — разобрать ответ агента нечем.',
    en: "The contour answered with something other than JSON — there is nothing to parse the agent's answer with.",
  },
  'contour-agent-unknown-shape': {
    ru: 'Контур ответил в форме, которую панель не узнала: разбирать нечего.',
    en: 'The contour answered in a shape the panel did not recognise: there is nothing to parse.',
  },
  'contour-agent-answered': { ru: 'Агент ответил.', en: 'The agent answered.' },
  'contour-agent-empty': {
    ru: 'Агент ответил пустым сообщением.',
    en: 'The agent answered with an empty message.',
  },
  'contour-agent-session-rejected': {
    ru: 'Контур не принял идентификатор сессии (422).',
    en: 'The contour did not accept the session id (422).',
  },
  'contour-agent-said': {
    ru: '{{message}} Контур сказал: {{detail}}',
    en: '{{message}} The contour said: {{detail}}',
  },
  'contour-agent-no-license': {
    ru: 'Агенты не входят в лицензию этого контура — их включает компания, а не панель.',
    en: "Agents are not part of this contour's licence — the company enables them, not the panel.",
  },
  'contour-agent-license-inactive': {
    ru: 'Лицензия контура неактивна: агенты не работают, пока её не продлят.',
    en: "The contour's licence is inactive: agents do not work until it is renewed.",
  },
  'contour-agent-license-unchecked': {
    ru: 'Контур не смог проверить свою лицензию — это его сторона, повторите позже.',
    en: 'The contour could not verify its own licence — that is its side, try again later.',
  },
  'contour-agent-key-rejected': {
    ru: 'Ключ отклонён контуром (401): отозван либо исчерпан его бюджет.',
    en: 'The key was rejected by the contour (401): it is revoked or its budget is spent.',
  },
  'contour-agent-key-forbidden': {
    ru: 'Ключу не разрешено звать агентов (403).',
    en: 'The key is not allowed to call agents (403).',
  },
  'contour-agent-key-budget': {
    ru: 'Исчерпан бюджет ключа (402).',
    en: "The key's budget is spent (402).",
  },
  'contour-agent-not-found': {
    ru: 'Контур не нашёл такого агента (404). Проверьте идентификатор в админке.',
    en: 'The contour did not find such an agent (404). Check the id in the platform admin.',
  },
  'contour-agent-failed': { ru: 'Агент завершился ошибкой.', en: 'The agent ended with an error.' },
  'contour-agent-rate-limited': {
    ru: 'Контур ограничил частоту запросов (429).',
    en: 'The contour rate-limited the requests (429).',
  },
  'contour-agent-status': {
    ru: 'Контур ответил ошибкой {{status}}.',
    en: 'The contour answered with error {{status}}.',
  },
  'contour-agent-rejected': {
    ru: 'Контур не принял запрос ({{status}}).',
    en: 'The contour did not accept the request ({{status}}).',
  },
  'contour-agent-nothing-to-ask': {
    ru: 'Нечего спрашивать: сообщений нет.',
    en: 'Nothing to ask: there are no messages.',
  },
  'contour-agent-last-must-be-question': {
    ru: 'Последним сообщением должен быть вопрос человека.',
    en: "The last message must be the human's question.",
  },
  'contour-agent-no-system-with-session': {
    ru: 'С сессией системное сообщение не передаётся — контур его не хранит.',
    en: 'With a session the system message is not sent — the contour does not keep it.',
  },
  'contour-probe-not-api': {
    ru: 'Адрес ответил {{status}}, но это не список моделей: {{hint}}.',
    en: 'The address answered {{status}}, but this is not a model list: {{hint}}.',
  },
  'contour-probe-not-api-address': {
    ru: 'Адрес ответил {{status}}, но это не список моделей: {{hint}}. {{address}}',
    en: 'The address answered {{status}}, but this is not a model list: {{hint}}. {{address}}',
  },
  'contour-probe-bad-url': {
    ru: 'Адрес контура должен быть корректным http(s)-адресом.',
    en: 'The contour address must be a valid http(s) URL.',
  },
  'contour-probe-no-key': {
    ru: 'Адрес отвечает как API контура и без ключа отказал ({{status}}) — так и должно быть: ключ ещё не введён. Введите его на следующем шаге.',
    en: 'The address answers like the contour API and refused without a key ({{status}}) — as it should: the key has not been entered yet. Enter it at the next step.',
  },
  'contour-probe-unauthorized': { ru: '{{message}} (401).', en: '{{message}} (401).' },
  'contour-probe-forbidden': {
    ru: 'Ключу не разрешено то, что запросила панель (403). Проверьте права ключа.',
    en: "The key is not allowed to do what the panel asked (403). Check the key's permissions.",
  },
  'contour-probe-not-ready': {
    ru: '{{message}} ({{status}}). Повторите проверку.',
    en: '{{message}} ({{status}}). Run the check again.',
  },
  'contour-probe-server-error': {
    ru: 'Контур ответил ошибкой {{status}}. Это его сторона — повторите позже.',
    en: 'The contour answered with error {{status}}. That is its side — try again later.',
  },
  'contour-probe-no-catalog-path': {
    ru: 'список моделей по этому пути не найден',
    en: 'no model list was found at this path',
  },
  'contour-probe-html': {
    ru: 'вернулась HTML-страница, а не JSON',
    en: 'an HTML page came back, not JSON',
  },
  'contour-probe-not-json': {
    ru: 'ответ не разбирается как JSON',
    en: 'the answer does not parse as JSON',
  },
  'contour-probe-no-models-field': {
    ru: 'в ответе нет списка моделей (ни поля data, ни массива)',
    en: 'the answer holds no model list (neither a data field nor an array)',
  },
  'contour-probe-ok': {
    ru: 'Контур ответил: моделей {{count}}.',
    en: 'The contour answered, models: {{count}}.',
  },
  'contour-probe-timeout': {
    ru: 'Контур не ответил за {{seconds}} с.',
    en: 'The contour did not answer within {{seconds}} s.',
  },
  'contour-address-admin': {
    ru: 'Похоже, это адрес админки: публичный API живёт на отдельном хосте (обычно api.<домен>).',
    en: 'This looks like the admin address: the public API lives on a separate host (usually api.<domain>).',
  },
  'contour-thinking-default': { ru: 'по умолчанию', en: 'by default' },
  'contour-thinking-on': { ru: 'включено', en: 'on' },
  'contour-thinking-off': { ru: 'выключено', en: 'off' },
  'contour-where-outside': { ru: 'вне панели', en: 'outside the panel' },
  'contour-conflict-tools-title': {
    ru: 'Инструменты платформы ⟷ наша прослойка инструментов',
    en: 'Platform tools ⟷ our tool shim',
  },
  'contour-conflict-tools-detail': {
    ru: 'Два набора инструментов на один ход: наш едет текстом и собирается обратно из ответа, набор контура исполняет сам контур. Включить оба нельзя — выберите один.',
    en: "Two tool sets for one turn: ours travels as text and is reassembled from the answer, the contour's set is executed by the contour itself. Both cannot be on — pick one.",
  },
  'contour-conflict-anonymization-title': {
    ru: 'Подмена данных контура ⟷ наша маска данных',
    en: "The contour's data substitution ⟷ our data mask",
  },
  'contour-conflict-anonymization-detail': {
    ru: 'Не выбор из двух: слои складываются по порядку. По API-ключу подмена у контура не гарантирована — проба стенда показала запрос без подмены, а карту подмены клиенту API контур не отдаёт. Поэтому наша маска у такого контура включается сама: она идёт первой, обратима, и её метки контур не трогает. Выключать ничего не нужно.',
    en: "Not a choice between two: the layers stack in order. Over an API key the contour's substitution is not guaranteed — the stand probe showed a request without it, and the contour does not hand the substitution map to an API client. So our mask turns itself on for such a contour: it goes first, it is reversible, and the contour does not touch its markers. Nothing needs to be switched off.",
  },
  'contour-conflict-anonymization-detail-off': {
    ru: 'Не выбор из двух: слои складываются по порядку. По API-ключу подмена у контура не гарантирована — проба стенда показала запрос без подмены, а карту подмены клиенту API контур не отдаёт. Наша маска у такого контура включается сама, но СЕЙЧАС она выключена на этой карточке: запрос уедет в контур как есть. Включает переключатель «Маска данных панели» выше.',
    en: 'Not a choice between two: the layers stack in order. Over an API key the contour’s substitution is not guaranteed — the stand probe showed a request without it, and the contour does not hand the substitution map to an API client. Our mask turns itself on for such a contour, but RIGHT NOW it is off on this card: the request goes to the contour as it is. The “The panel’s data mask” switch above turns it on.',
  },
  'contour-conflict-compaction-title': {
    ru: 'Сжатие истории контуром ⟷ наши контрольные точки',
    en: 'History compaction by the contour ⟷ our checkpoints',
  },
  'contour-conflict-compaction-detail': {
    ru: 'Длинную переписку контур сжимает сам, а контрольная точка панели описывает историю целиком. После сжатия продолжение может не знать начала задачи — держите точку свежей.',
    en: "The contour compacts a long conversation itself, while the panel's checkpoint describes the whole history. After compaction the continuation may not know the start of the task — keep the checkpoint fresh.",
  },
  'contour-conflict-guardrails-title': {
    ru: 'Проверки содержимого контура ⟷ наш гейт промпта',
    en: "The contour's content checks ⟷ our prompt gate",
  },
  'contour-conflict-guardrails-detail': {
    ru: 'Проверяют оба и по разным спискам: гейт панели откажет до отправки и назовёт правило, контур откажет у себя статусом 451. Второй отказ не означает, что первый не сработал.',
    en: "Both check, and by different lists: the panel's gate refuses before sending and names the rule, the contour refuses on its side with status 451. The second refusal does not mean the first one did not fire.",
  },
  'contour-control-tools-title': { ru: 'Инструменты платформы', en: 'Platform tools' },
  'contour-control-tools-detail': {
    ru: 'имена инструментов контура; пусто — наверх уходит «tool_choice: none»',
    en: "names of the contour's tools; empty — «tool_choice: none» goes upstream",
  },
  'contour-control-toolmode-title': { ru: 'Цикл вызовов платформы', en: 'Platform call loop' },
  'contour-control-toolmode-detail': {
    ru: '«loop» — контур ходит по кругу сам, «single_turn» — возвращает вызов клиенту; такой ход идёт к контуру не потоком',
    en: '«loop» — the contour goes round the loop itself, «single_turn» — it returns the call to the client; such a turn goes to the contour without streaming',
  },
  'contour-control-preset-title': { ru: 'Пресет генерации', en: 'Generation preset' },
  'contour-control-preset-detail': {
    ru: 'именованный набор параметров на стороне контура; пусто — контур берёт свой',
    en: "a named parameter set on the contour's side; empty — the contour takes its own",
  },
  'contour-control-thinking-title': { ru: 'Размышления модели', en: 'Model reasoning' },
  'contour-control-thinking-detail': {
    ru: 'включить или выключить доходит только до моделей на самохостед vLLM — остальным провайдерам контур поле не передаёт; по умолчанию не отправляется, решает шаблон модели. Размышления наружу не уходят',
    en: 'switching it on or off reaches only models on self-hosted vLLM — to other providers the contour does not pass the field; by default it is not sent and the model template decides. The reasoning itself never leaves the contour',
  },
  'contour-control-thinking-manifest-detail': {
    ru: 'включить или выключить полем «{{path}}»; по умолчанию не отправляется, решает шаблон модели',
    en: 'switch it on or off with the field «{{path}}»; by default it is not sent and the model template decides',
  },
  'contour-control-guardrails-title': { ru: 'Проверки содержимого', en: 'Content checks' },
  'contour-control-guardrails-detail': {
    ru: 'включает владелец контура; отказ приходит статусом 451',
    en: "the contour's owner switches it on; the refusal arrives as status 451",
  },
  'contour-control-owner-enables': {
    ru: 'включает владелец контура',
    en: "the contour's owner enables it",
  },
  'contour-control-anonymization-title': { ru: 'Подмена данных', en: 'Data substitution' },
  'contour-control-anonymization-detail': {
    ru: 'есть у собственного чата контура; по API-ключу проба стенда показала запрос БЕЗ подмены, и карту клиенту API контур не отдаёт',
    en: 'present in the contour’s own chat; over an API key the stand probe saw the request go WITHOUT substitution, and the contour hands the map to no API client',
  },
  'contour-control-knowledge-title': { ru: 'Знания компании', en: 'Company knowledge' },
  'contour-control-knowledge-where': {
    ru: 'подмешивает владелец ключа',
    en: "the key's owner mixes it in",
  },
  'contour-control-knowledge-detail': {
    ru: 'подмешиваются владельцем ключа, отдельного маршрута нет',
    en: "mixed in by the key's owner, there is no separate route",
  },
  'contour-control-context-title': { ru: 'Сжатие истории', en: 'History compaction' },
  'contour-control-context-where': { ru: 'решает контур', en: 'the contour decides' },
  'contour-control-context-detail': {
    ru: 'длинную переписку контур сжимает сам — наши контрольные точки об этом не знают',
    en: 'the contour compacts a long conversation itself — our checkpoints know nothing about it',
  },
  'contour-notes-no-capabilities': {
    ru: 'Возможности сверх списка моделей у совместимого шлюза не объявлены.',
    en: 'A compatible gateway declares no capabilities beyond the model list.',
  },
  'contour-tools-dropped': {
    ru: 'Тип контура выбрасывает поле инструментов — без прослойки агент не сможет править файлы.',
    en: 'This contour type drops the tools field — without the shim the agent will not be able to edit files.',
  },
  'contour-tools-refused': {
    ru: 'Запрос с инструментом отклонён ({{status}}).',
    en: 'The request with a tool was refused ({{status}}).',
  },
  'contour-tools-call-as-text': {
    ru: 'Модель написала вызов текстом: поле инструментов до неё не дошло или она его не понимает.',
    en: 'The model wrote the call as text: the tools field did not reach it, or it does not understand the field.',
  },
  'contour-tools-no-call': {
    ru: 'Модель ответила без вызова инструмента.',
    en: 'The model answered without calling a tool.',
  },
  'contour-tools-failed': {
    ru: 'Проба инструментов не прошла: {{reason}}.',
    en: 'The tools probe did not pass: {{reason}}.',
  },
  'contour-required-gateway-down': {
    ru: 'Контур «{{title}}» обязателен, а шлюз ядра не поднят — прогон не запущен, чтобы не уйти в облако вендора. Нажмите «Поднять шлюз» на карточке контура (раздел «Контур») либо верните провайдер по умолчанию.',
    en: 'The contour «{{title}}» is required, and the core gateway is down — the run was not started, so that it would not slip into the vendor cloud. Press «Start the gateway» on the contour card (the «Contour» section) or switch the provider back to the default one.',
  },
  'contour-required-no-token': {
    ru: 'Контур «{{title}}» обязателен, а ключ контура не сохранён — прогон не запущен, чтобы не уйти в облако вендора. Сохраните ключ («Настроить» на карточке контура → шаг «Ключ») либо верните провайдер по умолчанию.',
    en: 'The contour «{{title}}» is required, and its key is not saved — the run was not started, so that it would not slip into the vendor cloud. Save the key («Configure» on the contour card → the «Key» step) or switch the provider back to the default one.',
  },
  'contour-required-cli-config': {
    ru: 'Контур «{{title}}» обязателен, а в конфиге CLI стоит {{setting}} — с ней прогон или его часть ушли бы мимо контура, а окружением CLI её не перебить. Прогон не запущен. Исправьте эту настройку в конфиге CLI либо верните провайдер по умолчанию.',
    en: 'The contour «{{title}}» is required, and the CLI config has {{setting}} — with it the run or part of it would bypass the contour, and the CLI offers no environment variable to override it. The run was not started. Fix that setting in the CLI config or switch the provider back to the default one.',
  },
  'contour-target-assistant': { ru: 'Ассистент панели', en: 'Panel assistant' },
  'contour-bridge-script-missing': {
    ru: 'Не найден скрипт переходника tools/mcp/platform.mjs — панель запущена не из своего репозитория.',
    en: 'The bridge script tools/mcp/platform.mjs was not found — the panel was started outside its own repository.',
  },
  'checks-section-mcp': { ru: 'MCP-серверы', en: 'MCP servers' },
  'checks-section-permissions': { ru: 'Права', en: 'Permissions' },
  'checks-section-env': { ru: 'Переменные окружения', en: 'Environment variables' },
  'checks-skip-own-routes': {
    ru: '{{title}}: раздел обслуживается собственными маршрутами панели, универсальный круг записи к нему не применяется.',
    en: "{{title}}: this section is served by the panel's own routes, the universal write cycle does not apply to it.",
  },
  'checks-skip-absent': {
    ru: '{{title}}: у этого провайдера такого раздела нет.',
    en: '{{title}}: this provider has no such section.',
  },
  'checks-assistant-off': {
    ru: 'Запуск ассистента отключён в этой проверке.',
    en: 'Starting the assistant is switched off in this check.',
  },
  'checks-assistant-unsupported': {
    ru: 'Ассистент у этого провайдера не поддержан.',
    en: 'The assistant is not supported for this provider.',
  },
  'checks-assistant-launch-failed': {
    ru: 'Запуск не состоялся: {{reason}}',
    en: 'The launch did not happen: {{reason}}',
  },
  'checks-assistant-nothing-to-run': {
    ru: 'Запускать нечем: CLI не найден и ключ не задан — это не отказ провайдера.',
    en: "Nothing to run with: the CLI was not found and no key is set — this is not the provider's refusal.",
  },
  'checks-assistant-error': {
    ru: 'Ассистент ответил ошибкой.',
    en: 'The assistant answered with an error.',
  },
  'checks-assistant-empty': {
    ru: 'Ассистент ответил пустым сообщением.',
    en: 'The assistant answered with an empty message.',
  },
  'checks-assistant-ok': {
    ru: 'Ассистент ответил через {{mode}}: «{{reply}}».',
    en: 'The assistant answered through {{mode}}: «{{reply}}».',
  },
  'checks-cli-found': {
    ru: 'Команда {{command}} найдена в PATH.',
    en: 'The command {{command}} was found in PATH.',
  },
  'checks-cli-missing': {
    ru: 'Бинарь CLI в PATH не найден. Разделы конфигурации от этого не ломаются — ограничен только запуск ассистента через CLI.',
    en: 'The CLI binary was not found in PATH. The configuration sections are not broken by this — only starting the assistant through the CLI is limited.',
  },
  'checks-config-undeclared': {
    ru: 'Расположение конфигурации у провайдера не объявлено.',
    en: 'The provider declares no configuration location.',
  },
  'checks-config-missing': {
    ru: 'Ни один из путей конфигурации не найден ({{paths}}). Обычно они появляются после первого запуска CLI.',
    en: "None of the configuration paths were found ({{paths}}). They usually appear after the CLI's first run.",
  },
  'checks-config-present': {
    ru: 'Конфигурация на месте: {{paths}}.',
    en: 'The configuration is in place: {{paths}}.',
  },
  'checks-format-rejected': {
    ru: 'Формат файла не принят: {{reason}}',
    en: 'The file format was not accepted: {{reason}}',
  },
  'checks-format-no-schema': {
    ru: 'Схема {{file}} официально не публикуется — сверять не с чем.',
    en: 'No official schema is published for {{file}} — nothing to check against.',
  },
  'checks-mcp-reread-missing': {
    ru: 'Запись пробного сервера прошла, но при перечитывании его нет — формат файла разобран не полностью.',
    en: 'Writing the probe server succeeded, but on re-reading it is gone — the file format is not fully parsed.',
  },
  'checks-mcp-neighbours': {
    ru: 'После добавления и удаления пробного сервера список отличается от исходного — запись меняет соседние записи.',
    en: 'After adding and removing the probe server the list differs from the original — writing changes neighbouring entries.',
  },
  'checks-mcp-ok': {
    ru: 'Круг чтения-записи сошёлся на копии файла, серверов в нём: {{count}}.',
    en: 'The read-write cycle closed on a copy of the file, servers in it: {{count}}.',
  },
  'checks-permissions-meaning': {
    ru: 'Перезапись прочитанных прав изменила их смысл — формат разобран не полностью.',
    en: 'Rewriting the permissions that were read changed their meaning — the format is not fully parsed.',
  },
  'checks-permissions-ok': {
    ru: 'Права прочитаны и записаны обратно на копии файла без изменения смысла.',
    en: 'The permissions were read and written back on a copy of the file without changing their meaning.',
  },
  'checks-env-reread-missing': {
    ru: 'Пробная переменная записана, но при перечитывании её нет — формат разобран не полностью.',
    en: 'The probe variable was written, but on re-reading it is gone — the format is not fully parsed.',
  },
  'checks-env-set-differs': {
    ru: 'После добавления и удаления пробной переменной набор отличается от исходного.',
    en: 'After adding and removing the probe variable the set differs from the original.',
  },
  'checks-env-ok': {
    ru: 'Круг чтения-записи сошёлся на копии файла, переменных в нём: {{count}}.',
    en: 'The read-write cycle closed on a copy of the file, variables in it: {{count}}.',
  },
  'checks-instructions-unsupported': {
    ru: 'Раздел инструкций у этого провайдера не поддержан.',
    en: 'The instructions section is not supported for this provider.',
  },
  'checks-instructions-cursor': {
    ru: 'Инструкции Cursor — каталог правил `.mdc`; круг записи по каталогу не выполняется.',
    en: "Cursor's instructions are a directory of `.mdc` rules; the write cycle is not run over a directory.",
  },
  'checks-instructions-list-not-allowed': {
    ru: 'Список инструкций не разрешён.',
    en: 'The instructions list is not permitted.',
  },
  'checks-instructions-list-changed': {
    ru: 'Перезапись списка ссылок изменила его состав.',
    en: 'Rewriting the list of links changed its contents.',
  },
  'checks-instructions-list-ok': {
    ru: 'Список ссылок перезаписан без изменений, записей в нём: {{count}}.',
    en: 'The list of links was rewritten unchanged, entries in it: {{count}}.',
  },
  'checks-instructions-undeclared': {
    ru: 'Файл инструкций у провайдера не объявлен.',
    en: 'The provider declares no instructions file.',
  },
  'checks-instructions-file-absent': {
    ru: 'Файла {{path}} ещё нет — он появится, когда инструкции будут заданы.',
    en: 'The file {{path}} does not exist yet — it appears once instructions are set.',
  },
  'checks-instructions-file-ok': {
    ru: 'Файл инструкций читается и записывается без изменений ({{count}} символов).',
    en: 'The instructions file reads and writes back unchanged ({{count}} characters).',
  },
  'checks-instructions-file-changed': {
    ru: 'Перезапись файла инструкций изменила его текст.',
    en: 'Rewriting the instructions file changed its text.',
  },
  'checks-instructions-file-unread': {
    ru: 'Файл не прочитан: {{reason}}',
    en: 'The file was not read: {{reason}}',
  },
  'checks-core-route-absent': {
    ru: 'Ядро исполнения задач не запущено — маршрут этого CLI у ядра не проверялся.',
    en: 'The task execution core is not running — this CLI’s route in the core was not checked.',
  },
  'checks-core-route-unverified': {
    ru: 'Строку ядра не подтвердила ОС, запрос к ядру не отправлен: {{reason}}',
    en: 'The OS did not confirm the core entry, no request was sent to the core: {{reason}}',
  },
  'checks-core-route-unreachable': {
    ru: 'Ядро не отдало список маршрутов: {{reason}}',
    en: 'The core did not return its route list: {{reason}}',
  },
  'checks-core-route-none': {
    ru: 'У ядра нет маршрута {{route}} — задачи ядра на этом CLI не запускаются.',
    en: 'The core has no route {{route}} — core tasks do not run on this CLI.',
  },
  'checks-core-route-ok': {
    ru: 'Маршрут ядра {{route}}: доступ есть, маршрут не исчерпан.',
    en: 'Core route {{route}}: credential present, route not exhausted.',
  },
  'checks-core-route-exhausted': {
    ru: 'Маршрут ядра {{route}} исчерпан: задачи на нём не запустятся, пока человек не снимет отметку.',
    en: 'Core route {{route}} is exhausted: tasks on it will not start until a person clears the mark.',
  },
  'checks-core-route-no-credential': {
    ru: 'У маршрута ядра {{route}} нет доступа — войдите в CLI.',
    en: 'Core route {{route}} has no credential — sign in to the CLI.',
  },
  'checks-core-route-credential-unknown': {
    ru: 'Маршрут ядра {{route}} есть, но наличие входа ядро не знает: хранилище входа CLI оно не читает.',
    en: 'Core route {{route}} exists, but the core does not know whether you are signed in: it never reads the CLI login store.',
  },
  'sandbox-event-bash-safe-title': { ru: 'Безобидная команда', en: 'A harmless command' },
  'sandbox-event-bash-safe-description': {
    ru: 'Обычный вызов Bash — страж не должен вмешиваться.',
    en: 'An ordinary Bash call — the guard should not step in.',
  },
  'sandbox-event-bash-destructive-title': { ru: 'Рекурсивное удаление', en: 'Recursive deletion' },
  'sandbox-event-bash-destructive-description': {
    ru: 'Опасная команда — страж разрушительных операций должен остановить.',
    en: 'A dangerous command — the guard over destructive operations should stop it.',
  },
  'sandbox-event-git-push-title': { ru: 'Мутирующая операция git', en: 'A mutating git operation' },
  'sandbox-event-git-push-description': {
    ru: 'Пуш в удалённый репозиторий — по правилам агент этого делать не должен.',
    en: 'A push to the remote repository — by the rules the agent must not do this.',
  },
  'sandbox-event-write-secret-title': {
    ru: 'Запись секрета в файл',
    en: 'Writing a secret into a file',
  },
  'sandbox-event-write-secret-description': {
    ru: 'В содержимом похожий на токен ключ — страж секретов должен вмешаться.',
    en: 'The content holds a token-shaped key — the secrets guard should step in.',
  },
  'sandbox-event-write-placeholder-title': {
    ru: 'Ключ-заготовка в примере',
    en: 'A placeholder key in an example',
  },
  'sandbox-event-write-placeholder-description': {
    ru: 'Значение-плейсхолдер в .env.example — страж не должен мешать.',
    en: 'A placeholder value in .env.example — the guard should not interfere.',
  },
  'sandbox-event-write-plain-title': { ru: 'Обычная правка файла', en: 'An ordinary file edit' },
  'sandbox-event-write-plain-description': {
    ru: 'Правка исходника — сюда обычно вешают автоформатирование.',
    en: 'An edit to a source file — auto-formatting is usually hung here.',
  },
  'sandbox-event-prompt-figma-title': {
    ru: 'Запрос со ссылкой на Figma',
    en: 'A request with a Figma link',
  },
  'sandbox-event-prompt-figma-description': {
    ru: 'Подсказки на ввод пользователя срабатывают здесь.',
    en: "Hints on the user's input fire here.",
  },
  'sandbox-event-session-start-title': { ru: 'Начало сессии', en: 'Session start' },
  'sandbox-event-session-start-description': {
    ru: 'Брифинги и напоминания при старте.',
    en: 'Briefings and reminders at the start.',
  },
  'sandbox-event-stop-title': { ru: 'Конец ответа', en: 'End of the answer' },
  'sandbox-event-stop-description': {
    ru: 'Проверки, которые запускаются после ответа модели.',
    en: "Checks that run after the model's answer.",
  },
  'sandbox-event-bad-json': {
    ru: 'Не удалось разобрать JSON: проверьте синтаксис события.',
    en: "The JSON did not parse: check the event's syntax.",
  },
  'sandbox-event-not-object': {
    ru: 'Событие должно быть JSON-объектом вида {"hook_event_name": "…"}.',
    en: 'The event must be a JSON object of the form {"hook_event_name": "…"}.',
  },
  'transfer-platform-key': { ru: 'ключ контура «{{id}}»', en: 'the key of contour «{{id}}»' },
  'transfer-platform-address-changed': {
    ru: 'адрес другой (было {{baseUrl}}) — сохранённый ключ будет снят, введите ключ нового адреса',
    en: 'the address differs (it was {{baseUrl}}) — the saved key will be dropped, enter the key of the new address',
  },
  'transfer-platform-key-saved': {
    ru: 'ключ этого контура на этой машине уже сохранён',
    en: 'the key of this contour is already saved on this machine',
  },
  'transfer-platform-key-absent': {
    ru: 'ключ в архив не попадает — введите его после разворота',
    en: 'the key does not go into the archive — enter it after the restore',
  },
  'transfer-platform-cert-missing': {
    ru: 'файла сертификата нет по пути {{path}}',
    en: 'there is no certificate file at {{path}}',
  },
  'transfer-platform-project-paths': {
    ru: 'пути проектов — с прежней машины, проверьте их на этой',
    en: 'the project paths come from the previous machine, check them on this one',
  },
  'transfer-platform-exclusion': {
    ru: '{{title}}: обе стороны включены — сохранение этого контура будет отклонено, выключите одну на карточке контура',
    en: "{{title}}: both sides are on — saving this contour will be refused, switch one off on the contour's card",
  },
  'plugins-list-failed': {
    ru: 'Список плагинов не получен: {{reason}}',
    en: 'The plugin list was not obtained: {{reason}}',
  },
  'commands-dir-missing': {
    ru: 'Каталог команд не найден: {{path}}.',
    en: 'The commands directory was not found: {{path}}.',
  },
  'integration-check-webhook-ok': {
    ru: 'Приёмник ответил на пробное событие.',
    en: 'The receiver answered the probe event.',
  },
  'integration-check-webhook-signed': {
    ru: 'Приёмник ответил на пробное событие (тело подписано).',
    en: 'The receiver answered the probe event (the body was signed).',
  },
  'integration-check-logged-in': { ru: 'Вошли как {{account}}.', en: 'Logged in as {{account}}.' },
  'integration-check-telegram-ok': {
    ru: 'Бот {{account}} на связи.',
    en: 'The bot {{account}} is reachable.',
  },
  'telegram-connect-no-candidate': {
    ru: 'Подтверждать некого: окно закрыто или /start ещё не пришёл.',
    en: 'Nobody to confirm: the window is closed or /start has not arrived yet.',
  },
  'integration-check-tms-ok': {
    ru: '{{detail}} — связь есть.',
    en: '{{detail}} — the connection works.',
  },
  'integration-check-atlassian-ok': {
    ru: 'Вошли как {{account}} ({{deployment}}).',
    en: 'Logged in as {{account}} ({{deployment}}).',
  },
  'integration-deployment-cloud': { ru: 'облако', en: 'cloud' },
  'integration-deployment-own': { ru: 'своя установка', en: 'own installation' },
  'integration-tms-project': {
    ru: '{{system}}, проект {{project}}',
    en: '{{system}}, project {{project}}',
  },
  'tms-cases-truncated': {
    ru: 'список кейсов проекта обрезан на {{max}} — кейс мог остаться за этой границей',
    en: "the project's case list was cut at {{max}} — a case may have stayed beyond that boundary",
  },
  'tms-check-marks': {
    ru: 'проверьте, что пометки «tms:» из этого проекта, а не из другого',
    en: 'check that the «tms:» marks come from this project and not from another one',
  },
  'env-move-settings-only': {
    ru: 'Переносить можно только переменные из settings.json / settings.local.json.',
    en: 'Only variables from settings.json / settings.local.json can be moved.',
  },
  'mcp-handshake-timeout': {
    ru: 'Сервер не ответил на рукопожатие вовремя',
    en: 'The server did not answer the handshake in time',
  },
  'mcp-oauth-timeout': { ru: 'Сервер не ответил вовремя', en: 'The server did not answer in time' },
  'env-name-invalid': {
    ru: 'Имя переменной — латинские буквы, цифры и подчёркивание, не с цифры: MY_TOKEN, а не «my token».',
    en: 'A variable name is Latin letters, digits and underscores, not starting with a digit: MY_TOKEN, not «my token».',
  },
  'env-source-invalid': {
    ru: 'Куда сохранить: settings, settings-local или secrets. Переменные групп правятся на странице групп.',
    en: 'Where to save: settings, settings-local or secrets. Group variables are edited on the groups page.',
  },
  'env-secret-single-line': {
    ru: 'Значение для .mcp-secrets.env — одна строка: перевод строки стал бы отдельной переменной.',
    en: 'A value for .mcp-secrets.env is a single line: a line break would become a separate variable.',
  },
  'env-key-exists-there': {
    ru: 'В {{file}} уже есть {{key}} — сначала удалите или переименуйте её там.',
    en: '{{file}} already holds {{key}} — delete or rename it there first.',
  },
  'panel-mcp-no-section': {
    ru: 'У активного CLI ({{provider}}) нет раздела MCP — переходнику некуда записаться. Переключите активный CLI в настройках.',
    en: 'The active CLI ({{provider}}) has no MCP section — the bridge has nowhere to register. Switch the active CLI in the settings.',
  },
  'instructions-file-absent': {
    ru: 'Файл {{path}} не существует. Панель не создаёт файлы, которых нет: создайте его сами или уберите запись из списка.',
    en: 'The file {{path}} does not exist. The panel does not create files that are missing: create it yourself or drop the entry from the list.',
  },
  'instructions-path-is-dir': {
    ru: 'Путь {{path}} — каталог, а не файл.',
    en: 'The path {{path}} is a directory, not a file.',
  },
  'instructions-file-too-large': {
    ru: 'Файл {{path}} слишком большой для правки в панели.',
    en: 'The file {{path}} is too large to edit in the panel.',
  },
  'instructions-file-not-text': {
    ru: 'Файл {{path}} не является текстовым — панель его не открывает.',
    en: 'The file {{path}} is not a text file — the panel does not open it.',
  },
  'mcp-auth-header-rejected': {
    ru: 'Сервер отверг заголовок Authorization (401) — проверьте токен в заголовках',
    en: 'The server rejected the Authorization header (401) — check the token in the headers',
  },
  'mcp-oauth-needed': {
    ru: 'Требуется авторизация OAuth — нажмите «Авторизоваться»',
    en: 'OAuth authorization is needed — press «Authorize»',
  },
  'project-dir-empty': { ru: 'Путь к проекту не задан', en: 'The path to the project is not set' },
  'project-dir-absent': {
    ru: 'Каталог не существует: {{dir}}',
    en: 'The directory does not exist: {{dir}}',
  },
  'project-dir-not-dir': { ru: 'Это не каталог: {{dir}}', en: 'This is not a directory: {{dir}}' },
  'tests-baseline-png-broken': { ru: 'Снимок не разобрался', en: 'The snapshot did not parse' },
  'tests-compare-plans-differ': {
    ru: 'прогоны шли по разным планам',
    en: 'the runs followed different plans',
  },
  'tests-compare-envs-differ': { ru: 'окружения разные', en: 'the environments differ' },
  'tests-compare-modes-differ': { ru: 'это разные режимы', en: 'these are different modes' },
  'tests-compare-warning': {
    ru: '{{parts}} — наборы кейсов не совпадают, и «починилось» может значить «в этот раз не гоняли».',
    en: '{{parts}} — the case sets do not match, and «fixed» may mean «not run this time».',
  },
  'tests-compare-base-missing': {
    ru: 'Прогона «{{id}}» в истории нет.',
    en: 'There is no run «{{id}}» in the history.',
  },
  'tests-compare-first-run': {
    ru: 'Сравнивать не с чем: это первый прогон с результатами.',
    en: 'There is nothing to compare with: this is the first run with results.',
  },
  'tests-draft-item-unparsed': {
    ru: 'Правка №{{index}} не разобралась.',
    en: 'Edit №{{index}} did not parse.',
  },
  'tests-draft-op-refused': {
    ru: 'Правка №{{index}}: «{{op}}» черновиком не делается — удаление кейсов остаётся человеку.',
    en: 'Edit №{{index}}: «{{op}}» is not done by a draft — deleting cases stays with the human.',
  },
  'tests-draft-group-missing': {
    ru: 'Правка №{{index}}: не названа группа.',
    en: 'Edit №{{index}}: the group is not named.',
  },
  'tests-draft-title-missing': {
    ru: 'Правка №{{index}}: кейс без названия.',
    en: 'Edit №{{index}}: a case without a title.',
  },
  'tests-draft-moved-to-group': {
    ru: 'Новых кейсов перенесено в группу «{{group}}»: {{count}} — её выбрал человек при запуске.',
    en: 'New cases moved into the group «{{group}}»: {{count}} — the human chose it at the start.',
  },
  'tests-draft-human-case': {
    ru: 'Кейс написан человеком — правку к нему принимают руками.',
    en: 'The case was written by a human — an edit to it is accepted by hand.',
  },
  'tests-pdf-no-browser': {
    ru: 'PDF печатает браузер, а на этой машине его не нашлось. Поставь Google Chrome, Microsoft Edge или Chromium (либо укажи путь к нему в переменной окружения {{env}}) — остальные форматы отчёта работают и без него.',
    en: 'A browser prints the PDF, and none was found on this machine. Install Google Chrome, Microsoft Edge or Chromium (or name its path in the {{env}} environment variable) — the other report formats work without it.',
  },
  'sandbox-event-custom-title': { ru: 'Свой ввод', en: 'Your own input' },
  'chat-process-lost': {
    ru: 'Процесс чата потерян: его завершили вне панели. Разговор сохранён — отправьте сообщение, и он продолжится с того же места.',
    en: 'The chat process was lost: it was ended outside the panel. The conversation is saved — send a message and it continues where it stopped.',
  },
  'core-chat-contour-down': {
    ru: 'Ход не отправлен: обязательный контур {{contour}} недоступен — у шлюза нет маршрута или ключа. В облако вендора ход не уходит. Проверьте контур в разделе «Контуры».',
    en: 'The turn was not sent: the required contour {{contour}} is unavailable — its gateway has no route or key. The turn never goes to the vendor cloud instead. Check the contour in «Contours».',
  },
  'core-chat-model-needed': {
    ru: 'Ход не отправлен: маршруту {{route}} нужна конкретная модель. Выберите модель чата или задайте модель контура по умолчанию.',
    en: 'The turn was not sent: route {{route}} needs a concrete model. Pick a chat model or set the contour default model.',
  },
  'core-chat-contour-model': {
    ru: 'Ход не отправлен: модель {{model}} недоступна в контуре {{contour}} — ключ контура её не разрешает. В облако вендора ход не уходит. Выберите в чате модель, которую контур открывает ключу (список — в разделе «Контуры»), или попросите администратора платформы разрешить ключу эту модель.',
    en: 'The turn was not sent: model {{model}} is not available in contour {{contour}} — the contour key does not allow it. The turn never goes to the vendor cloud instead. Pick a chat model the contour opens to its key (listed in «Contours»), or ask the platform administrator to allow this model for the key.',
  },
  'core-chat-estimate-refused': {
    ru: 'Ход не отправлен: ядро задач его не приняло (код {{code}}). Причина ядра: {{reason}}',
    en: 'The turn was not sent: the task core did not accept it (code {{code}}). Core reason: {{reason}}',
  },
  'core-chat-refused': {
    ru: 'Ядро задач отказало в ходе чата (код {{code}}). Причина записана в журнале задачи ядра.',
    en: 'The task core refused the chat turn (code {{code}}). The reason is in the core task journal.',
  },
  'core-chat-kit-hooks': {
    ru: 'Ход не начат: у этого шага хуки вашего слоя в режиме «{{mode}}» (сужены сценарием или правилом контура), а набор панели ставит свои хуки только при включённых. Снимите сужение хуков в правиле контура или переключите набор для этого CLI на «Только ваши» и выключите его стражи на странице «Набор панели».',
    en: 'The turn did not start: this step runs your layer’s hooks as «{{mode}}» (narrowed by the scenario or a contour rule), and the panel kit adds its hooks only while they are on. Remove the hook narrowing from the contour rule, or switch the kit for this CLI to «Yours only» and turn its guards off on the «Panel kit» page.',
  },
  'core-chat-kit-mcp': {
    ru: 'Ход не начат: каталог набора {{path}} объявляет MCP-серверы (.mcp.json или mcpServers в plugin.json) — они обошли бы список MCP сеанса ядра. Уберите их из своих файлов набора на странице «Набор панели»; серверы MCP подключаются в разделе «MCP-серверы».',
    en: 'The turn did not start: the kit folder {{path}} declares MCP servers (.mcp.json or mcpServers in plugin.json) — they would bypass the core session’s MCP list. Remove them from your kit files on the «Panel kit» page; MCP servers are connected in the «MCP servers» section.',
  },
  'core-chat-kit-missing': {
    ru: 'Ход не начат: ядро не нашло или не прочло каталог набора {{path}}. Панель собирает набор заново на каждом ходе — отправьте сообщение ещё раз; повторится — проверьте, что папка доступна для чтения.',
    en: 'The turn did not start: the core could not find or read the kit folder {{path}}. The panel rebuilds the kit on every turn — send the message again; if it repeats, check that the folder is readable.',
  },
  'core-chat-layer-untrusted': {
    ru: 'Ход не начат: в этой папке включён локальный слой проекта, а Claude Code папке не доверяет. Слой собран из файлов репозитория, и без доверия ядро его не запускает. Доверьте папку: откройте в ней claude в терминале и ответьте «да» на вопрос о доверии, затем отправьте сообщение ещё раз. Или выключите слой: «Проекты» → проект → «Из проекта» → «Локальный слой» → режим «Выключен»; тогда чат пойдёт без файлов репозитория, пока папке нет доверия.',
    en: 'The turn did not start: the project local layer is on in this folder, and Claude Code does not trust the folder. The layer is built from repository files, and the core does not run it without trust. Trust the folder: open claude in it in a terminal and answer «yes» to the trust question, then send the message again. Or turn the layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off»; the chat then runs without the repository files until the folder is trusted.',
  },
  'core-chat-layer-mode': {
    ru: 'Ход не начат: у этого шага слой вашей конфигурации в режиме «{{mode}}» (сужен сценарием или правилом контура), а локальный слой проекта едет только при полном. Снимите сужение в правиле контура или выключите локальный слой: «Проекты» → проект → «Из проекта» → «Локальный слой» → режим «Выключен».',
    en: 'The turn did not start: this step runs your configuration layer as «{{mode}}» (narrowed by the scenario or a contour rule), and the project local layer rides only with the full one. Remove the narrowing from the contour rule, or turn the local layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off».',
  },
  'core-chat-layer-sources': {
    ru: 'Ход не начат: панель собрала сеанс с командными файлами проекта рядом с локальным слоем — слой задвоил бы их. Это ошибка панели, а не вашей настройки: отправьте сообщение ещё раз; повторится — выключите локальный слой («Проекты» → проект → «Из проекта» → «Локальный слой» → «Выключен») и сообщите об ошибке.',
    en: 'The turn did not start: the panel assembled the session with the project team files beside the local layer — the layer would duplicate them. This is a panel fault, not your setting: send the message again; if it repeats, turn the local layer off («Projects» → the project → «From the project» → «Local layer» → «Off») and report the fault.',
  },
  'core-chat-layer-build': {
    ru: 'Ход не начат: ядро не смогло взять сборку локального слоя {{path}} — каталога нет, он не читается или объявляет MCP-серверы. Панель пересобирает слой на каждом ходе — отправьте сообщение ещё раз; повторится — откройте карточку «Локальный слой» («Проекты» → проект → «Из проекта»): там видна ошибка сборки, — или выключите слой.',
    en: 'The turn did not start: the core could not use the local layer build {{path}} — the folder is missing, unreadable or declares MCP servers. The panel rebuilds the layer on every turn — send the message again; if it repeats, open the «Local layer» card («Projects» → the project → «From the project»): the build error is shown there — or turn the layer off.',
  },
  'core-chat-layer-fit': {
    ru: 'Ход не начат: локальный слой проекта не помещается в сеанс ядра (часть «{{field}}»: инструкции длиннее 200 000 знаков или хук чужой формы). Сожмите инструкции слоя или выключите слой: «Проекты» → проект → «Из проекта» → «Локальный слой» → режим «Выключен».',
    en: 'The turn did not start: the project local layer does not fit the core session (part «{{field}}»: instructions over 200,000 characters or a hook of a foreign shape). Compress the layer instructions or turn the layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off».',
  },
  'core-chat-carry-unsupported': {
    ru: 'Ход не начат: CLI {{adapter}} не умеет взять в сеанс ядра часть слоя панели ({{fields}}: набор, локальный слой или сужение настроек). Начните чат в Claude Code или выключите эту часть для этого CLI.',
    en: 'The turn did not start: the {{adapter}} CLI cannot take part of the panel layer into the core session ({{fields}}: the kit, the local layer or a settings narrowing). Start the chat in Claude Code, or turn that part off for this CLI.',
  },
  'chat-run-not-in-ledger': {
    ru: 'Панель перезапускалась, прогон не в реестре — отправьте сообщение заново.',
    en: 'The panel was restarted and the run is not in the ledger — send the message again.',
  },
  'chat-run-stopped-no-answer': {
    ru: 'Прогон остановлен: ответа не было.',
    en: 'The run was stopped: there was no answer.',
  },
  'dlp-rule-id-duplicate': {
    ru: 'правило «{{name}}»: идентификатор повторяется',
    en: 'the rule «{{name}}»: the identifier repeats',
  },
  'dlp-rule-regex-broken': {
    ru: 'правило «{{name}}»: выражение не разбирается',
    en: 'the rule «{{name}}»: the expression does not parse',
  },
  'dlp-rule-no-builtin': {
    ru: 'правило «{{name}}»: не выбран встроенный образец',
    en: 'the rule «{{name}}»: no built-in sample is chosen',
  },
  'dlp-rule-dictionary-empty': {
    ru: 'правило «{{name}}»: словарь пуст',
    en: 'the rule «{{name}}»: the dictionary is empty',
  },
  'media-block-too-large': {
    ru: 'Блок слишком велик — панель такой не принимает.',
    en: 'The block is too large — the panel does not accept it.',
  },
  'endpoint-probe-timeout': {
    ru: 'Адрес не ответил за {{seconds}} с.',
    en: 'The address did not answer within {{seconds}} s.',
  },
  'group-by-id-absent': { ru: 'Группы «{{id}}» нет.', en: 'There is no group «{{id}}».' },
  'group-name-taken': {
    ru: 'Группа «{{name}}» уже есть — по имени её находят и удаляют, двух одинаковых быть не должно.',
    en: 'The group «{{name}}» already exists — it is found and deleted by name, and there must not be two of them.',
  },
  'group-env-key-invalid': {
    ru: 'Имя переменной «{{key}}» не годится: латиница, цифры и подчёркивание, не с цифры.',
    en: 'The variable name «{{key}}» will not do: latin letters, digits and underscore, not starting with a digit.',
  },
  'tests-lint-no-oracle': {
    ru: 'Нечем доказать результат',
    en: 'Nothing to prove the result with',
  },
  'tests-lint-step-without-expected': { ru: 'Шаг без ожидания', en: 'A step with no expectation' },
  'tests-lint-no-code-paths': { ru: 'Нет привязки к коду', en: 'No link to the code' },
  'tests-lint-no-priority': { ru: 'Нет приоритета', en: 'No priority' },
  'tests-lint-too-many-steps': { ru: 'Слишком длинный сценарий', en: 'The scenario is too long' },
  'tests-lint-vague-case': {
    ru: 'Ожидание ничего не называет',
    en: 'The expectation names nothing',
  },
  'tests-lint-undeclared-parameter': {
    ru: 'Параметр не объявлен',
    en: 'The parameter is not declared',
  },
  'tests-lint-unused-parameter': {
    ru: 'Параметр объявлен впустую',
    en: 'The parameter is declared for nothing',
  },
  'tests-lint-duplicate-title': {
    ru: 'Повтор заголовка в группе',
    en: 'A repeated title inside the group',
  },
  'tests-lint-obsolete-not-archived': {
    ru: 'Устаревший кейс не в архиве',
    en: 'An obsolete case is not archived',
  },
  'tests-lint-stale-draft': { ru: 'Черновик залежался', en: 'The draft has been sitting too long' },
  'tests-lint-not-run': { ru: 'Давно не гонялся', en: 'Not run for a long time' },
  'tests-lint-checklist-with-expected': {
    ru: 'Чек-лист с ожиданием',
    en: 'A checklist with an expectation',
  },
  'worktree-copy-gap-files': { ru: 'нет файлов: {{files}}', en: 'missing files: {{files}}' },
  'worktree-copy-gap-links': { ru: 'нет ссылок: {{links}}', en: 'missing links: {{links}}' },
  'worktree-copy-gap-mcp': {
    ru: 'в .mcp.json копии нет серверов оригинала: {{names}}',
    en: 'the copy .mcp.json lacks the original servers: {{names}}',
  },
  'worktree-copy-gap-hooks': {
    ru: 'в settings.local.json копии не прописаны хуки оригинала: {{names}}',
    en: 'the copy settings.local.json lacks the original hooks: {{names}}',
  },
  'worktree-copy-gap-access': {
    ru: 'нет записи доступа — агент спросит про доверие и MCP',
    en: 'no access entry — the agent will ask about trust and MCP',
  },
  'worktree-mirror-moved': {
    ru: 'Локальный слой: перенесено {{count}}',
    en: 'Local layer: {{count}} copied',
  },
  'worktree-mirror-linked': { ru: 'ссылкой: {{paths}}', en: 'by link: {{paths}}' },
  'worktree-mirror-kept': { ru: 'без изменений {{count}}', en: '{{count}} unchanged' },
  'worktree-mirror-skipped-count': { ru: 'пропущено {{count}}', en: '{{count}} skipped' },
  'worktree-mirror-unlisted': { ru: 'за бортом: {{paths}}', en: 'left out: {{paths}}' },
  'worktree-mirror-failed': {
    ru: 'Локальный слой не перенесён: {{reason}}',
    en: 'The local layer was not copied: {{reason}}',
  },
  'worktree-access-copied': {
    ru: 'Доступ копии: перенесены доверие и настройки MCP ({{fields}} полей)',
    en: 'Copy access: trust and MCP settings carried over ({{fields}} fields)',
  },
  'worktree-access-skipped': {
    ru: 'Доступ копии не заведён: {{reason}}',
    en: 'Copy access was not created: {{reason}}',
  },
  'worktree-access-reason-unknown': { ru: 'причину git не назвал', en: 'git named no reason' },
  'worktree-copy-incomplete-line': {
    ru: 'Копия неполная: {{gaps}}',
    en: 'The copy is incomplete: {{gaps}}',
  },
  'worktree-created': {
    ru: 'Копия {{target}} готова на ветке {{branch}}',
    en: 'Copy {{target}} is ready on branch {{branch}}',
  },
  'worktree-longpath-refused': {
    ru: 'Windows не дал создать копию в {{target}}: путь длиннее 260 символов.\nПанель уже просит git о длинных путях и укорачивает имя каталога, но глубину самого\nрепозитория выбирает не она. Включите длинные пути в системе — «Редактор локальной\nгрупповой политики» → Конфигурация компьютера → Административные шаблоны → Система →\nФайловая система → «Включить длинные пути Win32», либо в реестре\nHKLM\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\FileSystem\\\\LongPathsEnabled = 1, — и повторите.\nБыстрый обходной путь: перенести репозиторий ближе к корню диска.\n\nОтвет git: {{error}}',
    en: 'Windows refused to create the copy at {{target}}: the path is longer than 260 characters.\nThe panel already asks git for long paths and shortens the directory name, but the depth of the\nrepository itself is not its choice. Turn long paths on in the system — Local Group Policy Editor\n→ Computer Configuration → Administrative Templates → System → Filesystem → “Enable Win32 long\npaths”, or in the registry\nHKLM\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\FileSystem\\\\LongPathsEnabled = 1 — and repeat.\nQuick workaround: move the repository closer to the drive root.\n\ngit answered: {{error}}',
  },
  'git-failed-no-output': { ru: 'Команда git завершилась с ошибкой', en: 'The git command failed' },
  'worktree-install-started': {
    ru: 'Установка запущена: {{command}}',
    en: 'Installation started: {{command}}',
  },
  'split-triage-interrupted-hold': {
    ru: 'Разбор оборвался при перезапуске панели и итога не даст. Запустить группу как предложено? Ответ уедет в её задачу.',
    en: 'The triage was cut short by a panel restart and will never give a result. Start the group as proposed? Your answer rides into its task.',
  },
  'split-triage-interrupted-notice': {
    ru: 'Разбор оборвался перезапуском панели — итога не будет. Групп ждёт вашего ответа: {{groups}}; сами они не стартуют.',
    en: 'The triage was cut short by a panel restart — there will be no result. Groups waiting for your answer: {{groups}}; they will not start by themselves.',
  },
  'path-step-started-notice': {
    ru: 'Шаг пути группы «{{step}}» идёт в этом чате.',
    en: 'Group path step “{{step}}” runs in this chat.',
  },
  'path-gate-nudge-notice': {
    ru: 'Шаг пути «{{step}}» закончил ход без итога проверки — панель один раз попросила его отчитаться. Без итога и после этого цепочка будет ждать ответа в этом чате.',
    en: 'Path step “{{step}}” ended its turn without a check result — the panel asked it once to report. Without a result after that, the chain waits for an answer in this chat.',
  },
  'path-gate-failed-notice': {
    ru: 'Шаг пути «{{step}}» не прошёл проверку: {{note}}. Цепочка ждёт ответа в этом чате.',
    en: 'Path step “{{step}}” did not pass its check: {{note}}. The chain waits for an answer in this chat.',
  },
  'group-same-session-notice': {
    ru: 'Группа продолжает ту же сессию: окно {{tokens}}k из {{window}}k до сжатия — чистая сессия перечитала бы всё, что уже в нём.',
    en: 'The group continues in the same session: context {{tokens}}k of the {{window}}k compaction window — a fresh session would re-read everything already in it.',
  },
  'review-skipped-notice': {
    ru: 'Ревью не заводилось: с коммита {{from}} своих изменений у работы нет — ни новых коммитов, ни разрешённых конфликтов в слияниях, ни отличий после rebase.',
    en: 'No review was started: since commit {{from}} the work has no changes of its own — no new commits, no conflict resolutions in merges, no differences after a rebase.',
  },
  'split-limit-wait-notice': {
    ru: 'Группы разделения упёрлись в лимит подписки и ждут его сброса до {{until}}: продолжатся сами, очередь до сброса не стартует.',
    en: 'Split groups hit the subscription limit and wait for its reset at {{until}}: they resume by themselves, and the queue does not start until then.',
  },
  'chat-conversation-lost-notice': {
    ru: 'Прежний разговор группы продолжить нельзя: его файла ({{lost}}) на диске нет. Ход пошёл новым разговором в той же копии — ветка, MR и задачи переданы ему вводной.',
    en: "The group's previous conversation cannot be continued: its file ({{lost}}) is not on disk. The turn went on as a new conversation in the same copy — the branch, MR and tasks were handed to it in the brief.",
  },
  'chat-cold-resume-notice': {
    ru: 'Группа простояла дольше срока кэша, её разговор остыл, а окно уже {{tokens}} тыс. токенов: продолжать его — заново записать всё окно. Ход пошёл новым разговором в той же копии; вводную панель собрала из файлов — заметки группы, git, последний ответ. Прежний разговор ({{previous}}) остаётся на диске: вернуть ход в него — кнопкой «Продолжить старый разговор», пока новый идёт. Выключается в настройках: «Группы», экономия групп.',
    en: "The group stood idle past its cache lifetime, its conversation went cold, and the window is already {{tokens}}k tokens: continuing it means writing the whole window again. The turn went on as a new conversation in the same copy; the panel built the brief from files — the group's notes, git, the last answer. The previous conversation ({{previous}}) stays on disk: to move the turn back into it, press «Continue the old conversation» while the new one runs. Switch off in settings: Groups, group economy.",
  },
  'chat-mr-relay-fresh-notice': {
    ru: 'Слово панели доставленной группе (конвейер или обсуждения MR) пошло новым разговором в той же копии: окно прежнего уже {{tokens}} тыс. токенов, и каждый запрос хода перечитывал бы всю доставку. Вводную панель собрала из файлов — ветка, MR, задачи, заметки группы, git, последний ответ. Прежний разговор ({{previous}}) остаётся на диске: вернуть ход в него — кнопкой «Продолжить старый разговор», пока новый идёт. Выключается в настройках: «Группы», экономия групп.',
    en: "The panel's word to a delivered group (MR pipeline or discussions) went on as a new conversation in the same copy: the previous window is already {{tokens}}k tokens, and every request of the turn would re-read the whole delivery. The panel built the brief from files — branch, MR, tasks, the group's notes, git, the last answer. The previous conversation ({{previous}}) stays on disk: to move the turn back into it, press «Continue the old conversation» while the new one runs. Switch off in settings: Groups, group economy.",
  },
  'chat-auto-continue-notice': {
    ru: 'Ход оборвался: {{reason}}. Чат продолжит сам через {{seconds}} с (попытка {{attempt}} из {{max}}).',
    en: 'The turn broke off: {{reason}}. The chat will continue on its own in {{seconds}} s (attempt {{attempt}} of {{max}}).',
  },
  'chat-auto-continue-spent-notice': {
    ru: 'Ход оборвался: {{reason}}. Автоматические продолжения исчерпаны ({{max}} из {{max}}) — нужен человек.',
    en: 'The turn broke off: {{reason}}. Automatic continuations are used up ({{max}} of {{max}}) — a human is needed.',
  },
  'chat-background-ask-notice': {
    ru: 'Главный ход уже закончился, а фоновая работа агента ({{count}}: {{tasks}}) просит решения. Карточка ниже; когда фон закончится, агент продолжит здесь же сам.',
    en: "The main turn has already ended, but the agent's background work ({{count}}: {{tasks}}) needs a decision. The card is below; once the background work finishes, the agent continues here on its own.",
  },
  'chat-events-trimmed-notice': {
    ru: 'Долгий прогон: {{count}} старых кадров потока сброшено из памяти панели. Полная переписка — в истории разговора после завершения хода.',
    en: "Long run: {{count}} old stream frames were dropped from the panel's memory. The full conversation is in the chat history once the turn ends.",
  },
  'chat-stop-unconfirmed-notice': {
    ru: 'Остановить процесс агента ({{pid}}) не удалось: без снимка процессов панель не может проверить, что этот номер всё ещё его, а чужой процесс не трогает. Прогон остаётся идущим — нажмите «Остановить» ещё раз; после перезапуска панели он будет подхвачен снова.',
    en: "The agent process ({{pid}}) could not be stopped: without a process snapshot the panel cannot verify that this number is still the agent's, and it never touches a foreign process. The run stays running — press Stop again; after a panel restart it is picked up again.",
  },
  'split-group-run-not-started': { ru: 'прогон не запустился', en: 'the run did not start' },
  'delivery-human-merge': {
    ru: 'нужен человек — слияние: {{what}}',
    en: 'a human is needed — merge: {{what}}',
  },
  'delivery-human-destructive': {
    ru: 'нужен человек — удаление данных git или вне своей копии, force-push сверх аренды, запись в БД или публикация пакета: {{what}}',
    en: 'a human is needed — deleting git data or outside its own copy, a force-push beyond the lease, a DB write or a package publish: {{what}}',
  },
  'delivery-human-credentials': {
    ru: 'нужен человек — доступа нет нигде в проекте: {{what}}',
    en: 'a human is needed — credentials that exist nowhere in the project: {{what}}',
  },
  'sieve-gap-conflicts': {
    ru: 'сито «интеграция»: слияние со свежей основной веткой даёт конфликт в {{files}} — перенесите ветку на свежую основную (rebase) и разрешите конфликт',
    en: 'integration sieve: merging with fresh main conflicts in {{files}} — rebase the branch onto fresh main and resolve the conflict',
  },
  'sieve-gap-foreign-removals': {
    ru: 'сито «чужие −»: ветка удаляет строки, пришедшие в основную после старта группы: {{files}} — верните их или назовите каждый файл полным путём в строке foreign-removals отчёта о ситах с причиной',
    en: 'foreign-removals sieve: the branch deletes lines that landed in main after the group started: {{files}} — restore them or name every file by its full path in the foreign-removals row of the sieve report with the reason',
  },
  'sieve-gap-consumers': {
    ru: 'сито «потребители вне диффа»: удалённое ({{tokens}}) ещё используется в {{files}} — поправьте потребителей или назовите каждый файл в строке consumers-repo-wide отчёта о ситах с причиной',
    en: 'consumers sieve: removed names ({{tokens}}) are still used in {{files}} — fix the consumers or name every file in the consumers-repo-wide row of the sieve report with the reason',
  },
  'sieve-gap-unreported': {
    ru: 'сито {{sieve}} не отчитано: нужна строка в блоке {{lang}} — {"sieves":[{"id":"…","status":"pass|fail|n/a","evidence":"команда и строка её вывода или причина"}]}',
    en: 'sieve {{sieve}} is not reported: a row is needed in a {{lang}} block — {"sieves":[{"id":"…","status":"pass|fail|n/a","evidence":"the command and a line of its output, or the reason"}]}',
  },
  'sieve-gap-no-evidence': {
    ru: 'сито {{sieve}} отмечено без доказательства: нужна команда и строка её вывода или причина',
    en: 'sieve {{sieve}} is marked without evidence: the command and a line of its output, or the reason, are needed',
  },
  'sieve-gap-failed': {
    ru: 'сито {{sieve}} не пройдено: {{evidence}} — исправьте и сдайте строку снова; живую проверку, которую здесь не запустить, сдайте «not checked: <причина>», красное не из-за ветки — «not caused by the branch: <почему>»',
    en: 'sieve {{sieve}} failed: {{evidence}} — fix it and report the row again; a live check that cannot run here is reported «not checked: <reason>», red not caused by the branch — «not caused by the branch: <why>»',
  },
  'sieve-gap-lockfile': {
    ru: 'сито «lockfile»: манифест зависимостей изменён без своего лок-файла: {{files}} — пересоберите лок штатным менеджером пакетов проекта или назовите каждый манифест в строке lockfile-sync отчёта о ситах с причиной',
    en: 'lockfile sieve: a dependency manifest changed without its lockfile: {{files}} — regenerate the lock with the project package manager or name every manifest in the lockfile-sync row of the sieve report with the reason',
  },
  'sieve-gap-secrets': {
    ru: 'сито «секреты»: в добавленных строках ключ, токен или приватный ключ: {{files}} — уберите его из ветки и замените (удалённый из ветки секрет всё равно утёк) или назовите каждый файл в строке secrets отчёта о ситах, объяснив, почему это не настоящий секрет',
    en: 'secrets sieve: a key, token or private key in added lines: {{files}} — remove it from the branch and rotate it (a secret removed from the branch has still leaked) or name every file in the secrets row of the sieve report with why it is not a real secret',
  },
  'sieve-gap-debug': {
    ru: 'сито «остатки отладки»: .only, debugger или маркер конфликта в добавленном: {{files}} — уберите их или назовите каждый файл в строке debug-leftovers отчёта о ситах с причиной',
    en: 'debug-leftovers sieve: .only, debugger or a conflict marker in added lines: {{files}} — remove them or name every file in the debug-leftovers row of the sieve report with the reason',
  },
  'sieve-gap-artifacts': {
    ru: 'сито «лишнее в git»: добавлены файлы, которым не место в репозитории (игнорируемые, .env, ключи, крупнее 5 МБ): {{files}} — уберите их из ветки или назовите каждый в строке committed-artifacts отчёта о ситах с причиной',
    en: 'committed-artifacts sieve: files that do not belong in git were added (ignored, .env, keys, over 5 MB): {{files}} — remove them from the branch or name each in the committed-artifacts row of the sieve report with the reason',
  },
  'sieve-gap-env': {
    ru: 'сито «конфигурация»: код начал читать переменные окружения, которые нигде не объявлены: {{names}} — добавьте их в .env.example, конфигурацию развёртывания или документацию или назовите каждую в строке env-config отчёта о ситах с причиной',
    en: 'env-config sieve: the code started reading environment variables declared nowhere: {{names}} — add them to .env.example, the deployment config or the docs, or name each in the env-config row of the sieve report with the reason',
  },
  'sieve-gap-untested': {
    ru: 'сито «тесты рядом с кодом»: изменён код ({{files}}), а ни один тест в ветке не изменён — добавьте тест на изменённое поведение или сдайте строку tests-alongside: какой тест его покрывает, либо n/a с причиной',
    en: 'tests-alongside sieve: code changed ({{files}}) but no test changed in the branch — add a test for the changed behaviour or report the tests-alongside row: which test covers it, or n/a with the reason',
  },
  'sieve-gap-checks': {
    ru: 'сито {{sieve}}: в доказательстве нет проверок проекта {{commands}} — прогоните каждую на последнем коммите и назовите её со строкой вывода; не запустилась — это fail с причиной, а не n/a',
    en: 'sieve {{sieve}}: the evidence does not name the project checks {{commands}} — run each on the final commit and name it with its output line; one that could not run is a fail with the reason, not an n/a',
  },
  'sieve-gap-destructive': {
    ru: 'сито «миграции»: разрушающие операторы (DROP, TRUNCATE, переименование, сужение типа) в {{files}} — строка migration-safety должна назвать каждый файл и план сохранения данных и отката',
    en: 'migration-safety sieve: destructive statements (DROP, TRUNCATE, rename, type narrowing) in {{files}} — the migration-safety row must name every file with its data-preserving and rollback plan',
  },
  'sieve-gap-stale': {
    ru: 'сито {{sieve}}: после сдачи строки ветка меняла задетый ситом код ({{files}}) — проверьте заново на последнем коммите и сдайте строку снова',
    en: 'sieve {{sieve}}: the branch changed the code this sieve covers after the row was reported ({{files}}) — check again on the final commit and report the row again',
  },
  'sieve-gap-no-run': {
    ru: 'сито {{sieve}}: живая проверка не подтверждена прогоном — проверьте на стенде с этой веткой (или тестом маршрута через настоящий маршрут) кейсом блока «Тесты» с меткой из: {{tags}}, прогоните его блоком «Тесты» (`tests-cli run`) и укажите прогон в доказательстве как run:<id>; засчитывается только прогон, исполненный блоком «Тесты», кейса с меткой не от группы — прогон, записанный вручную, метка, которую группа поставила своему кейсу, юнит- и сервисный тест не в счёт; не запустить здесь — статус fail и доказательство «not checked: <причина>»',
    en: 'sieve {{sieve}}: the live check is not backed by a run — check it against a stand running this branch (or with the route test through the real route) as a Tests-section case tagged one of: {{tags}}, run it through the Tests block (`tests-cli run`) and cite the run in the evidence as run:<id>; only a run the Tests block executed (`tests-cli run`) of a case tagged by someone else counts — a run recorded by hand, a tag the group set on its own case and a unit or service test do not; cannot run it here — status fail with evidence "not checked: <reason>"',
  },
  'sieve-gap-no-run-cite': {
    ru: 'сито {{sieve}}: прогон {{run}} из истории блока «Тесты» уже подходит — укажите его в доказательстве как run:{{run}}, прогонять заново не нужно',
    en: 'sieve {{sieve}}: run {{run}} in the Tests history already fits — cite it in the evidence as run:{{run}}; no rerun is needed',
  },
  'sieve-gap-run-not-live': {
    ru: 'сито {{sieve}}: в прогоне {{run}} нет живой проверки — ни один прошедший кейс не помечен ({{tags}}), а юнит- или сервисный тест её не доказывает; не засчитываются и прогон, записанный вручную, и метка, которую группа поставила своему кейсу, — только прогон, исполненный блоком «Тесты» (`tests-cli run`), кейса с меткой не от группы; дифф только из `tools/` и `scripts/` доказывает и исполненный прогон кейса, чьи codePaths называют эти файлы; проверьте на стенде с этой веткой или тестом маршрута через настоящий маршрут кейсом с такой меткой, не запустить здесь — статус fail и доказательство «not checked: <причина>»',
    en: 'sieve {{sieve}}: run {{run}} holds no live check — no passed case in it is tagged ({{tags}}), and a unit or service test does not prove it; a run recorded by hand and a tag the group set on its own case do not count either — only a run the Tests block executed (`tests-cli run`) of a case tagged by someone else; a diff of only `tools/` and `scripts/` files is also proved by an executed run of a case whose codePaths name those files; check against a stand running this branch or with the route test through the real route as a case with such a tag, or — if it cannot run here — status fail with evidence "not checked: <reason>"',
  },
  'sieve-gap-flip': {
    ru: 'сито {{sieve}}: строка стала pass без нового доказательства — {{why}}',
    en: 'sieve {{sieve}}: the row turned pass with no new proof — {{why}}',
  },
  'sieve-gap-run-missing': {
    ru: 'сито {{sieve}}: прогона {{run}} нет в истории блока «Тесты» копии или он не закончен — запишите прогон и укажите его номер',
    en: 'sieve {{sieve}}: run {{run}} is not in the Tests history of the copy or did not finish — record the run and cite its id',
  },
  'sieve-gap-run-empty': {
    ru: 'сито {{sieve}}: прогон {{run}} ничего не проверил — все кейсы пропущены или результатов нет; поднимите стенд и запишите новый прогон',
    en: 'sieve {{sieve}}: run {{run}} checked nothing — every case was skipped or it has no results; bring the stand up and record a new run',
  },
  'sieve-gap-run-red': {
    ru: 'сито {{sieve}}: в прогоне {{run}} красные кейсы: {{cases}} — почините и запишите новый прогон',
    en: 'sieve {{sieve}}: run {{run}} has red cases: {{cases}} — fix them and record a new run',
  },
  'sieve-gap-run-stale': {
    ru: 'сито {{sieve}}: прогон {{run}} старше правки задетого ситом кода ({{files}}) — прогоните заново на последнем коммите',
    en: 'sieve {{sieve}}: run {{run}} is older than the change to the code this sieve covers ({{files}}) — run it again on the final commit',
  },
  'sieve-gap-live-na': {
    ru: 'сито {{sieve}}: живую проверку нельзя сдать n/a — дифф меняет поведение ({{files}}); проверьте вживую на последнем коммите и сдайте pass со ссылкой run:<id> записанного прогона блока «Тесты», где прошёл кейс с одной из меток: {{tags}}, а не вышло — fail с причиной',
    en: 'sieve {{sieve}}: a live check cannot be reported n/a — the diff changes behaviour ({{files}}); check it live on the final commit and report pass citing run:<id> of a recorded Tests-section run where a case tagged one of: {{tags}} passed, or fail with the reason if it could not run',
  },
  'sieve-gap-count-no-cite': {
    ru: 'сито {{sieve}}: доказательство называет счёт тестов блока «Тесты» («{{claim}}»), но не ссылается на прогон — укажите run:<id> прогона, который его напечатал (последний записанный — run:{{run}}: прошло {{passed}}, упало {{failed}})',
    en: 'sieve {{sieve}}: the evidence quotes a Tests-section test count («{{claim}}») but cites no run — cite run:<id> of the run that printed it (the latest recorded is run:{{run}}: {{passed}} passed, {{failed}} failed)',
  },
  'sieve-gap-count-no-run': {
    ru: 'сито {{sieve}}: доказательство называет счёт тестов блока «Тесты» («{{claim}}»), а прогона в истории копии нет — запишите прогон (tests-cli run) и сошлитесь на него как run:<id>',
    en: 'sieve {{sieve}}: the evidence quotes a Tests-section test count («{{claim}}») but the copy has no recorded run — record one (tests-cli run) and cite it as run:<id>',
  },
  'sieve-gap-count-mismatch': {
    ru: 'сито {{sieve}}: счёт в доказательстве («{{claim}}») не сходится с прогоном run:{{run}} — в нём прошло {{passed}}, упало {{failed}}; перепишите счёт по выводу прогона, а упавшее почините или назовите в строке',
    en: 'sieve {{sieve}}: the count in the evidence («{{claim}}») does not match run:{{run}} — it has {{passed}} passed, {{failed}} failed; rewrite the count from the run output, and fix what failed or name it in the row',
  },
  'tests-gap-no-run': {
    ru: 'блок «Тесты» копии: после старта группы не записано ни одного прогона — прогоните кейсы по изменённым файлам ({{cases}}) и запишите прогон: {{command}}',
    en: 'Tests block of the copy: no run has been recorded since the group started — run the cases for the changed files ({{cases}}) and record the run: {{command}}',
  },
  'tests-gap-word-only': {
    ru: 'блок «Тесты» копии: после старта группы есть только запись словом (tests-cli record), а она автоматический кейс не закрывает — запустите кейсы по изменённым файлам ({{cases}}) командой: {{command}}',
    en: 'Tests block of the copy: since the group started there is only a word-only record (tests-cli record), which does not close an automated case — run the cases for the changed files ({{cases}}) with: {{command}}',
  },
  'tests-gap-stale': {
    ru: 'блок «Тесты» копии: прогон {{run}} записан раньше последней правки — прогоните кейсы заново и запишите прогон: {{command}} (правка под кейсами: {{files}})',
    en: 'Tests block of the copy: run {{run}} was recorded before the latest change — run the cases again and record the run: {{command}} (changed under the cases: {{files}})',
  },
  'tests-gap-unrun': {
    ru: 'блок «Тесты» копии: кейсы по изменённым файлам не прогнаны после старта группы: {{cases}} — запишите прогон: {{command}}',
    en: 'Tests block of the copy: cases for the changed files were not run since the group started: {{cases}} — record a run: {{command}}',
  },
  'tests-gap-failed': {
    ru: 'блок «Тесты» копии: красные кейсы в прогонах группы: {{cases}} — почините и прогоните снова; красные и без ветки — докажите прогоном на развилке с основной: {{command}}',
    en: 'Tests block of the copy: red cases in the group’s runs: {{cases}} — fix them and run again; red without the branch too — prove it with a run on the fork point with main: {{command}}',
  },
  'tests-gap-uncovered': {
    ru: 'блок «Тесты» копии: изменённые файлы не покрыты ни одним кейсом ({{files}}) — заведите кейс с codePaths на них',
    en: 'Tests block of the copy: the changed files are not covered by any case ({{files}}) — add a case with codePaths pointing at them',
  },
  'tests-note-red-baseline': {
    ru: 'блок «Тесты» копии: красные и без ветки — до старта группы или на развилке с основной: {{cases}} — не из-за ветки, группу не держат; назовите их в описании MR',
    en: 'Tests block of the copy: red without the branch too — before the group started or on the fork point with main: {{cases}} — not caused by the branch, they do not hold the group; name them in the MR description',
  },
  'tests-note-red-environment': {
    ru: 'блок «Тесты» копии: не выполнились (blocked) или красные от окружения (таймаут, сеть, стенд, платформа) там, где дифф их не задел: {{cases}} — не из-за ветки, группу не держат; назовите их в описании MR',
    en: 'Tests block of the copy: could not run (blocked), or red from the environment (timeout, network, stand, platform) where the diff does not touch them: {{cases}} — not caused by the branch, they do not hold the group; name them in the MR description',
  },
  'assistant-route-refused': {
    ru: 'Помощник не запущен: {{reason}}',
    en: 'The helper did not start: {{reason}}',
  },
  'assistant-provider-unsupported': {
    ru: 'У {{provider}} нет судьи ядра, который отказал бы встроенному инструменту на каждом вызове, — служебный вопрос без инструментов ему не доверить. Переключите активный CLI на другой, например Claude или Qwen Code',
    en: '{{provider}} has no core judge that would refuse a built-in tool on every call — a service question without tools cannot be trusted to it. Switch the active CLI to another one, for example Claude or Qwen Code',
  },
  'assistant-extra-tool': {
    ru: 'Модель позвала встроенный инструмент ({{tool}}), а у служебного вопроса инструментов нет — ход остановлен, ответа нет.',
    en: 'The model called a built-in tool ({{tool}}), but a service question has no tools — the turn was stopped, there is no answer.',
  },
  'provider-chat-unsupported': {
    ru: 'У {{provider}} нет неинтерактивного запуска — чат панели с ним не работает. Разговор не создан: переключите активный CLI',
    en: '{{provider}} has no non-interactive mode — the panel chat cannot work with it. The conversation was not created: switch the active CLI',
  },
  'provider-chat-core': {
    ru: 'Чат чужого CLI идёт через ядро: старый разговор панели только читается — ход, остановка, перезапуск, очередь и ответ на запрос прав здесь больше не принимаются. Продолжите в чате ядра: раздел «Чат», кнопка «Новый»',
    en: 'A foreign CLI chat runs on the core: an old panel conversation is read-only — turns, stop, restart, queue and permission answers are no longer taken here. Continue in the core chat: section «Chat», button «New»',
  },
  'analytics-provider-unsupported': {
    ru: 'Аналитика читает журналы только Claude Code, Codex и Qwen Code, а активный CLI — {{provider}}. Данные Claude под ним не показываются',
    en: 'Analytics reads the logs of Claude Code, Codex and Qwen Code only, and the active CLI is {{provider}}. Claude data is not shown under it',
  },
  'analytics-live-foreign': {
    ru: 'Процессы на машине панель опознаёт только у Claude Code, а активный CLI — {{provider}}. Список пуст, чтобы не выдавать процессы claude за его собственные',
    en: 'The panel recognises running processes of Claude Code only, and the active CLI is {{provider}}. The list stays empty rather than pass claude processes off as its own',
  },
  'plugins-provider-unsupported': {
    ru: 'Раздел плагинов Claude Code работает только через claude, а активный CLI — {{provider}}. Команда не запущена',
    en: 'The Claude Code plugins section works through claude only, and the active CLI is {{provider}}. The command did not run',
  },
  'sandbox-provider-unsupported': {
    ru: 'Песочница запускает только Claude Code, а активный CLI — {{provider}}. Прогон не запущен',
    en: 'The sandbox runs Claude Code only, and the active CLI is {{provider}}. The run did not start',
  },
  'assistant-api-base-unknown': {
    ru: 'Адрес модельного API {{provider}} панели не известен — ключ никуда не отправлен, чтобы не уйти к чужому вендору. Установите CLI или выберите свой эндпоинт',
    en: 'The panel does not know the model API address of {{provider}} — the key was sent nowhere, so as not to reach another vendor. Install the CLI or pick your own endpoint',
  },
  'provider-unknown': {
    ru: 'Провайдер «{{id}}» неизвестен панели.',
    en: 'The panel does not know provider “{{id}}”.',
  },
  'panel-agent-stopped': {
    ru: 'Ход остановлен.',
    en: 'The turn was stopped.',
  },
  'panel-agent-extra-tool': {
    ru: 'CLI дал агенту инструмент сверх переходника панели ({{tool}}) — ход остановлен, чтобы у агента не было лишних рук.',
    en: 'The CLI gave the agent a tool beyond the panel bridge ({{tool}}) — the turn was stopped so that the agent has no extra hands.',
  },
  'panel-agent-timeout': {
    ru: 'Агент не закончил ход за отведённое время.',
    en: 'The agent did not finish the turn in the allotted time.',
  },
  'panel-agent-no-reply': {
    ru: 'Агент не ответил.',
    en: 'The agent did not answer.',
  },
  'panel-agent-cli-exit': {
    ru: 'CLI завершился с кодом {{code}} без ответа.',
    en: 'The CLI exited with code {{code}} without an answer.',
  },
  'panel-agent-model-error': {
    ru: 'Ход модели кончился ошибкой, а CLI её не назвал.',
    en: 'The model turn ended with an error and the CLI gave no words for it.',
  },
  'dlp-core-missing': {
    ru: 'ядро не найдено ({{reason}})',
    en: 'the core was not found ({{reason}})',
  },
  'dlp-core-unverified': {
    ru: 'строка ядра не сверена ({{reason}})',
    en: 'the core entry did not verify ({{reason}})',
  },
  'dlp-core-unverified-bare': {
    ru: 'строка ядра не сверена',
    en: 'the core entry did not verify',
  },
  'dlp-core-http': {
    ru: 'ядро ответило {{status}} на {{path}}',
    en: 'the core answered {{status}} to {{path}}',
  },
  'dlp-core-down': {
    ru: 'Защиту данных держит ядро, а оно не отвечает: {{reason}}',
    en: 'Data protection is held by the core, and it does not answer: {{reason}}',
  },
  'dlp-core-port-waiting': {
    ru: 'порт занят',
    en: 'the port is busy',
  },
  'dlp-core-port-busy': {
    ru: 'порт {{port}} занят ({{reason}})',
    en: 'port {{port}} is busy ({{reason}})',
  },
  'dlp-core-listener-silent': {
    ru: 'нет ответа слушателя',
    en: 'no answer from the listener',
  },
  'core-link-missing': {
    ru: 'Ядро не найдено: {{reason}}',
    en: 'The core was not found: {{reason}}',
  },
  'core-link-unreachable': {
    ru: 'Ядро не ответило: {{reason}}',
    en: 'The core did not answer: {{reason}}',
  },
  'media-image-blocked-no-route': {
    ru: 'Рисовать некому: ни активного контура, ни своего эндпоинта.',
    en: 'Nobody to draw: no active contour and no endpoint of your own.',
  },
  'media-image-blocked-driver-none': {
    ru: 'У этого контура генерации картинок нет.',
    en: 'This contour has no image generation.',
  },
  'media-image-blocked-no-model': {
    ru: 'Ни одна модель ключа не объявила рисование.',
    en: 'No model of the key declared drawing.',
  },
  'media-image-blocked-endpoint-no-url': {
    ru: 'У профиля эндпоинта не задан адрес генерации картинок.',
    en: 'The endpoint profile has no image generation address.',
  },
  'media-image-blocked-endpoint-api-kind': {
    ru: 'Картинки умеет только эндпоинт OpenAI-вида.',
    en: 'Only an OpenAI-kind endpoint can make images.',
  },
  'media-image-blocked-no-agent': {
    ru: 'Рисовать некому: нет ни растровой дороги, ни разговора с агентом.',
    en: 'Nobody to draw: no raster road and no conversation with an agent.',
  },
  'media-upstream-timeout-image': {
    ru: 'Картинка не пришла за {{seconds}} с — панель не ждёт дольше',
    en: 'The image did not arrive within {{seconds}} s — the panel does not wait longer',
  },
  'media-upstream-timeout-deck': {
    ru: 'Колода не пришла за {{seconds}} с — панель не ждёт дольше',
    en: 'The deck did not arrive within {{seconds}} s — the panel does not wait longer',
  },
  'media-core-not-connected': {
    ru: 'Запрос в контур идёт через звено ядра, а ядро панели не подключено.',
    en: "The request to the contour goes through a core hop, and the panel's core is not connected.",
  },
  'media-contour-link-failed': {
    ru: 'Звено ядра не дало адрес контура «{{contour}}»: {{reason}}',
    en: 'The core hop gave no address for contour «{{contour}}»: {{reason}}',
  },
  'kimi-mode-stale': {
    ru: '{{key}} = "{{mode}}" Kimi Code не принимает (допустимо: {{allowed}}) и при запуске молча его выбрасывает, работая в manual. Раздел только для чтения: исправьте значение в файле (kimi doctor config покажет ошибку), и правка снова откроется.',
    en: 'Kimi Code does not accept {{key}} = "{{mode}}" (allowed: {{allowed}}) and silently drops it at launch, running in manual. The section is read-only: fix the value in the file (kimi doctor config shows the error), and editing opens again.',
  },
} as const satisfies Record<string, { ru: string; en: string }>;
