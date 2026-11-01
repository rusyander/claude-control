/**
 * Тексты звена по кодам: перенос шаблонов панели (`lib/server-texts/templates.ts`) — только
 * коды, которые звено произносит. Код тот же, что у панели: при переключении панели на звено
 * (G2) её словарь узнаёт каждый текст. Порождено из шаблонов панели; правка — там и здесь.
 */
export const HOP_TEXTS = {
  'gateway-answer-truncated': {
    ru: 'Ответ контура оборвался: поток закончился без завершающего кадра — ответ неполон',
    en: "The contour's answer broke off: the stream ended without a final frame — the answer is incomplete",
  },
  'gateway-checks-stopped': {
    ru: 'Проверки контента контура остановили ответ',
    en: "The contour's content checks stopped the answer",
  },
  'gateway-checks-stopped-named': {
    ru: 'Проверки контента контура остановили ответ: {{names}}',
    en: "The contour's content checks stopped the answer: {{names}}",
  },
  'gateway-flaw-args': {
    ru: 'аргументы не разбираются как объект',
    en: 'arguments do not parse as an object',
  },
  'gateway-flaw-contour-args': {
    ru: 'аргументы вызова контура не разбираются',
    en: 'contour call arguments do not parse',
  },
  'gateway-flaw-contour-unnamed': {
    ru: 'вызов контура без имени',
    en: 'contour call without a name',
  },
  'gateway-flaw-empty': {
    ru: 'пустой блок вызова',
    en: 'empty call block',
  },
  'gateway-flaw-fence-midanswer': {
    ru: 'вызов забором посреди ответа не выполняется',
    en: 'a fenced call in the middle of an answer is not executed',
  },
  'gateway-flaw-fenced': {
    ru: 'вызов внутри блока кода не выполняется',
    en: 'a call inside a code block is not executed',
  },
  'gateway-flaw-loose-whole': {
    ru: 'вызов без тега принимается только целым объектом JSON',
    en: 'a call without tags is accepted only as a whole JSON object',
  },
  'gateway-flaw-no-name': {
    ru: 'в блоке нет имени инструмента',
    en: 'no tool name in the block',
  },
  'gateway-flaw-several': {
    ru: 'несколько вызовов в одном блоке',
    en: 'several calls in one block',
  },
  'gateway-flaw-stop-without-call': {
    ru: 'причина остановки «вызов» без единого вызова',
    en: 'stop reason “call” without a single call',
  },
  'gateway-flaw-unclosed': {
    ru: 'блок без закрывающего тега',
    en: 'block without a closing tag',
  },
  'gateway-flaw-undeclared': {
    ru: 'инструмент не объявлен клиентом',
    en: 'the tool is not declared by the client',
  },
  'gateway-flaw-not-json': {
    ru: 'не разбирается как JSON',
    en: 'does not parse as JSON',
  },
  'gateway-flaw-no-object': {
    ru: 'внутри блока нет объекта',
    en: 'no object inside the block',
  },
  'gateway-joined': {
    ru: '{{message}}: {{detail}}',
    en: '{{message}}: {{detail}}',
  },
  'gateway-mask-unrestorable': {
    ru: 'Вызов инструмента остановлен: метку защиты данных {{names}} нечем развернуть — она уехала бы в файл вместо значения',
    en: 'The tool call was stopped: data protection label {{names}} cannot be restored — it would go into the file instead of the value',
  },
  'gateway-retry-after': {
    ru: '{{message}}. Контур просит повторить через {{seconds}} с',
    en: '{{message}}. The contour asks to retry in {{seconds}} s',
  },
  'gateway-tool-blocked': {
    ru: 'Вызов «{{name}}» остановлен хуком PreToolUse',
    en: 'The “{{name}}” call was stopped by the PreToolUse hook',
  },
  'gateway-tool-blocked-why': {
    ru: 'Вызов «{{name}}» остановлен хуком PreToolUse: {{reason}}',
    en: 'The “{{name}}” call was stopped by the PreToolUse hook: {{reason}}',
  },
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
  'gateway-upstream-aborted': {
    ru: 'Контур прервал ответ: {{message}}',
    en: 'The contour aborted the answer: {{message}}',
  },
  'gateway-upstream-status': {
    ru: 'Контур ответил кодом {{status}}',
    en: 'The contour answered with code {{status}}',
  },
  'gateway-upstream-unnamed-error': {
    ru: 'та сторона закончила ответ ошибкой и не назвала её',
    en: 'the other side ended the answer with an error and did not name it',
  },
  'gateway-model-forbidden': {
    ru: 'Ключу не разрешена модель «{{model}}» на контуре — список разрешённых у ключа в админке платформы, а в разделе «Контур» видно то же самое списком моделей',
    en: "Model “{{model}}” is not allowed for the key on the contour — the key's allowed list is in the platform admin, and the Contour section shows the same as its model list",
  },
  'gateway-model-not-found': {
    ru: 'Контур ответил «не найдено» на запрос модели «{{model}}». Читается это двояко: модель убрали из контура между прогонами (в разделе «Контур» пропавшие помечены и хранят дату последней встречи) — либо адрес контура указывает не на публичный API, а, например, на админку, и тогда не найден маршрут, а не модель',
    en: 'The contour answered “not found” for model “{{model}}”. This reads two ways: the model was removed from the contour between runs (the Contour section marks vanished models and keeps the date they were last seen) — or the contour address points not at the public API but, for example, at the admin, and then the route was not found, not the model',
  },
  'gateway-answer-broken': {
    ru: 'Ответ контура оборвался: {{reason}}',
    en: "The contour's answer broke off: {{reason}}",
  },
  'gateway-answer-not-model': {
    ru: 'Контур ответил не потоком, и его тело не разбирается как ответ модели',
    en: 'The contour did not answer with a stream, and its body does not parse as a model answer',
  },
  'gateway-answer-too-large': {
    ru: 'Ответ контура больше 8 МБ — шлюз не собирает его целиком. Тот же запрос потоком приходит без этого потолка',
    en: "The contour's answer is over 8 MB — the gateway does not assemble it whole. The same request as a stream comes without this ceiling",
  },
  'gateway-body-not-json': {
    ru: 'Тело запроса не разбирается как JSON',
    en: 'The request body does not parse as JSON',
  },
  'gateway-body-too-large': {
    ru: 'Тело запроса больше 32 МБ — шлюз его не принимает',
    en: 'The request body is over 32 MB — the gateway does not accept it',
  },
  'gateway-ceiling-cut': {
    ru: 'Ответ контура оборвался на {{seconds}}-й секунде — это потолок самой платформы на любой ответ, поток тоже. Сеть здесь ни при чём: сократите ход (меньше размышлений, короче ответ) или попросите владельца контура поднять потолок',
    en: "The contour's answer broke off at second {{seconds}} — that is the platform's own ceiling for any answer, streams included. The network is not to blame: shorten the turn (less thinking, a shorter answer) or ask the contour owner to raise the ceiling",
  },
  'gateway-cert-failed': {
    ru: 'Сертификат контура не проверился: {{reason}}. Укажите корневой сертификат компании в настройках контура',
    en: 'The contour certificate did not verify: {{reason}}. Set the company root certificate in the contour settings',
  },
  'gateway-client-gone': {
    ru: 'Клиент отключился до конца ответа',
    en: 'The client disconnected before the answer ended',
  },
  'gateway-headers-timeout': {
    ru: 'Контур не начал отвечать за {{seconds}} с',
    en: 'The contour did not start answering within {{seconds}} s',
  },
  'gateway-headers-timeout-local': {
    ru: 'Локальная модель не начала отвечать за {{seconds}} с: длинный запрос обрабатывается дольше, чем отведено. Сожмите историю (/compact) или начните новый чат',
    en: 'The local model did not start answering within {{seconds}} s: a long prompt takes longer to process than allowed. Compact the history (/compact) or start a new chat',
  },
  'gateway-mask-blocked': {
    ru: 'Запрос остановлен правилом «{{rule}}» — в нём нашлись данные, которые не должны уходить в модель',
    en: 'The request was stopped by rule “{{rule}}” — it contains data that must not go to the model',
  },
  'gateway-mask-unparsed': {
    ru: 'Защита данных не разобрала тело запроса',
    en: 'Data protection could not parse the request body',
  },
  'gateway-mask-rules-broken': {
    ru: 'Защита данных включена, а правила не читаются ({{error}})',
    en: 'Data protection is on, but its rules cannot be read ({{error}})',
  },
  'gateway-no-connection': {
    ru: 'Нет связи с контуром: {{reason}}',
    en: 'No connection to the contour: {{reason}}',
  },
  'gateway-prefixed': {
    ru: 'AgentDeck: {{message}}',
    en: 'AgentDeck: {{message}}',
  },
  'gateway-redirect': {
    ru: 'Контур ответил перенаправлением ({{status}}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет',
    en: 'The contour answered with a redirect ({{status}}) — the panel did not follow it: the request would have gone to another address. Put the address it redirects to into the contour settings',
  },
  'gateway-redirect-to': {
    ru: 'Контур ответил перенаправлением на {{where}} ({{status}}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет',
    en: 'The contour answered with a redirect to {{where}} ({{status}}) — the panel did not follow it: the request would have gone to another address. Put the address it redirects to into the contour settings',
  },
  'gateway-route-unknown': {
    ru: 'Шлюз панели принимает только {{routes}} по адресу /<контур>/v1/...',
    en: 'The panel gateway accepts only {{routes}} at /<contour>/v1/...',
  },
  'gateway-url-not-http': {
    ru: 'Адрес контура не http(s): {{url}}',
    en: 'The contour address is not http(s): {{url}}',
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
  'proxy-body-not-json': {
    ru: 'тело запроса не JSON',
    en: 'the request body is not JSON',
  },
  'proxy-body-too-large': {
    ru: 'тело запроса слишком велико',
    en: 'the request body is too large',
  },
  'proxy-failed': {
    ru: 'прокси не смог обработать запрос',
    en: 'the proxy could not handle the request',
  },
  'proxy-shape-unknown': {
    ru: 'форма запроса не разбирается',
    en: 'the request shape does not parse',
  },
  'proxy-stopped-unparsed': {
    ru: 'AgentDeck: {{reason}}, запрос остановлен (настройка «пропускать неразобранное» выключена)',
    en: 'AgentDeck: {{reason}}, the request was stopped (the “Pass through unparsed bodies” setting is off)',
  },
  'proxy-upstream-unreachable': {
    ru: 'AgentDeck: адрес модели не отвечает ({{reason}})',
    en: 'AgentDeck: the model address does not answer ({{reason}})',
  },
} as const satisfies Record<string, { ru: string; en: string }>;
