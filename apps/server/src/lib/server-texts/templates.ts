/**
 * Шаблоны текстов, которые сервер собирает строкой (`../server-texts.ts`).
 * Генерируются из того же манифеста, что и словари клиентов, — правится манифест, не этот файл.
 */
export const serverTextTemplates = {
  'gateway-prefixed': { ru: 'AgentDeck: {{message}}', en: 'AgentDeck: {{message}}' },
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
    ru: 'Шлюз панели принимает только {{routes}} по адресу /<контур>/v1/...',
    en: 'The panel gateway accepts only {{routes}} at /<contour>/v1/...',
  },
  'gateway-contour-unknown': {
    ru: 'Контур «{{id}}» в панели не заведён',
    en: 'Contour “{{id}}” is not set up in the panel',
  },
  'gateway-contour-disabled': {
    ru: 'Контур «{{title}}» выключен в панели',
    en: 'Contour “{{title}}” is turned off in the panel',
  },
  'gateway-contour-no-key': {
    ru: 'У контура «{{title}}» не сохранён ключ',
    en: 'Contour “{{title}}” has no saved key',
  },
  'gateway-body-too-large': {
    ru: 'Тело запроса больше 32 МБ — шлюз его не принимает',
    en: 'The request body is over 32 MB — the gateway does not accept it',
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
  'gateway-answer-too-large': {
    ru: 'Ответ контура больше 8 МБ — шлюз не собирает его целиком. Тот же запрос потоком приходит без этого потолка',
    en: "The contour's answer is over 8 MB — the gateway does not assemble it whole. The same request as a stream comes without this ceiling",
  },
  'gateway-not-anthropic': {
    ru: 'Платформа ответила не сообщением диалекта Anthropic',
    en: 'The platform did not answer with an Anthropic dialect message',
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
  'gateway-failed': {
    ru: 'AgentDeck: шлюз не смог обработать запрос',
    en: 'AgentDeck: the gateway could not handle the request',
  },
  'gateway-ports-busy': {
    ru: 'порты {{from}}–{{to}} заняты: {{reason}}',
    en: 'ports {{from}}–{{to}} are busy: {{reason}}',
  },
  'gateway-ports-busy-unknown': { ru: 'причина неизвестна', en: 'reason unknown' },
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
  'proxy-not-configured': { ru: 'прокси не настроен', en: 'the proxy is not configured' },
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
    en: 'AgentDeck: {{reason}}, the request was stopped (the «let unparsed through» setting is off)',
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
    en: 'The contour answered: {{count}} models.',
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
    en: "Not a choice between two: the layers stack in order. Over an API key the contour's substitution is not guaranteed — the stand probe showed a request without it, and the contour does not hand the substitution map to an API client. Our mask turns itself on for such a contour, but RIGHT NOW it is off on this card: the request goes to the contour as it is. The “The panel’s data mask” switch above turns it on.",
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
    ru: 'Контур «{{title}}» обязателен, а шлюз панели не поднят — прогон не запущен, чтобы не уйти в облако вендора. Нажмите «Поднять шлюз» на карточке контура (раздел «Контур») либо верните провайдер по умолчанию.',
    en: "The contour «{{title}}» is required, and the panel's gateway is down — the run was not started, so that it would not slip into the vendor cloud. Press «Start the gateway» on the contour card (the «Contour» section) or switch the provider back to the default one.",
  },
  'contour-required-no-token': {
    ru: 'Контур «{{title}}» обязателен, а ключ контура не сохранён — прогон не запущен, чтобы не уйти в облако вендора. Сохраните ключ («Настроить» на карточке контура → шаг «Ключ») либо верните провайдер по умолчанию.',
    en: 'The contour «{{title}}» is required, and its key is not saved — the run was not started, so that it would not slip into the vendor cloud. Save the key («Configure» on the contour card → the «Key» step) or switch the provider back to the default one.',
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
  'integration-check-tms-ok': {
    ru: '{{detail}} — связь есть.',
    en: '{{detail}} — the connection works.',
  },
  'integration-check-atlassian-ok': {
    ru: 'Вошли как {{account}} ({{deployment}}).',
    en: 'Logged in as {{account}} ({{deployment}}).',
  },
  'integration-check-atlassian-confluence-ok': {
    ru: 'Вошли как {{account}} ({{deployment}}). Confluence на связи.',
    en: 'Logged in as {{account}} ({{deployment}}). Confluence is reachable.',
  },
  'integration-check-atlassian-confluence-rejected': {
    ru: 'Вошли как {{account}} ({{deployment}}). Confluence отклонил токен — заполните отдельный ключ Confluence.',
    en: 'Logged in as {{account}} ({{deployment}}). Confluence rejected the token — fill in the separate Confluence key.',
  },
  'integration-check-atlassian-confluence-failed': {
    ru: 'Вошли как {{account}} ({{deployment}}). Confluence ответил {{status}} — проверьте адрес Confluence.',
    en: 'Logged in as {{account}} ({{deployment}}). Confluence answered {{status}} — check the Confluence address.',
  },
  'integration-check-atlassian-confluence-unreachable': {
    ru: 'Вошли как {{account}} ({{deployment}}). Confluence недоступен: {{reason}}.',
    en: 'Logged in as {{account}} ({{deployment}}). Confluence is unreachable: {{reason}}.',
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
  'automation-not-found': { ru: 'Сценария «{{id}}» нет.', en: 'There is no automation «{{id}}».' },
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
} as const satisfies Record<string, { ru: string; en: string }>;
