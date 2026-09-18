import type { GatewayMessageCode } from '@agentdeck/contracts/server-messages';

export const gatewayRu: Record<GatewayMessageCode, string> = {
  'gateway-prefixed': 'AgentDeck: {{message}}',
  'gateway-joined': '{{message}}: {{detail}}',
  'gateway-upstream-400': 'Контур не принял запрос',
  'gateway-upstream-401': 'Контур отклонил ключ. Проверьте сам ключ и его права',
  'gateway-upstream-402': 'Контур отказал по лимиту расхода — до вызова модели',
  'gateway-upstream-403': 'Ключу не разрешена эта модель на контуре',
  'gateway-upstream-404': 'Контур не знает такого маршрута',
  'gateway-upstream-413': 'Запрос больше того, что контур принимает',
  'gateway-upstream-422': 'Контур не принял форму запроса',
  'gateway-upstream-429': 'Превышен лимит ключа на контуре (запросов или токенов в минуту)',
  'gateway-upstream-451': 'Запрос остановлен проверками содержимого на стороне контура',
  'gateway-upstream-500': 'Контур ответил ошибкой на своей стороне',
  'gateway-upstream-502': 'Контур не смог дозваться до модели',
  'gateway-upstream-503': 'Контур сейчас недоступен',
  'gateway-upstream-status': 'Контур ответил кодом {{status}}',
  'gateway-retry-after': '{{message}}. Контур просит повторить через {{seconds}} с',
  'gateway-model-forbidden':
    'Ключу не разрешена модель «{{model}}» на контуре — список разрешённых у ключа в админке платформы, а в разделе «Контур» видно то же самое списком моделей',
  'gateway-model-not-found':
    'Контур ответил «не найдено» на запрос модели «{{model}}». Читается это двояко: модель убрали из контура между прогонами (в разделе «Контур» пропавшие помечены и хранят дату последней встречи) — либо адрес контура указывает не на публичный API, а, например, на админку, и тогда не найден маршрут, а не модель',
  'gateway-key-rejected':
    'Контур отклонил ключ, и причину он не называет. Их пять: ключ неизвестен или отозван, истёк по сроку, исчерпал свой бюджет, его владельца удалили — либо сверка владельца на стороне контура не удалась (тогда ключ в порядке, и стоит повторить). Проверьте ключ, его срок, бюджет и владельца в админке платформы',
  'gateway-key-budget':
    'Исчерпан бюджет ключа — контур отказал до вызова модели. Поднять бюджет или дождаться нового периода ключа можно в админке платформы; через полминуты контур начнёт отклонять этот ключ кодом 401',
  'gateway-content-checks-request': 'Проверки контента контура остановили запрос',
  'gateway-registry-not-ready': 'Контур ещё поднимается: реестр моделей не готов',
  'gateway-route-unknown': 'Шлюз панели принимает только {{routes}} по адресу /<контур>/v1/...',
  'gateway-contour-unknown': 'Контур «{{id}}» в панели не заведён',
  'gateway-contour-disabled': 'Контур «{{title}}» выключен в панели',
  'gateway-contour-no-key': 'У контура «{{title}}» не сохранён ключ',
  'gateway-body-too-large': 'Тело запроса больше 32 МБ — шлюз его не принимает',
  'gateway-body-not-json': 'Тело запроса не разбирается как JSON',
  'gateway-answer-not-model':
    'Контур ответил не потоком, и его тело не разбирается как ответ модели',
  'gateway-client-gone': 'Клиент отключился до конца ответа',
  'gateway-answer-broken': 'Ответ контура оборвался: {{reason}}',
  'gateway-answer-truncated':
    'Ответ контура оборвался: поток закончился без завершающего кадра — ответ неполон',
  'gateway-upstream-aborted': 'Контур прервал ответ: {{message}}',
  'gateway-upstream-unnamed-error': 'та сторона закончила ответ ошибкой и не назвала её',
  'gateway-checks-stopped': 'Проверки контента контура остановили ответ',
  'gateway-checks-stopped-named': 'Проверки контента контура остановили ответ: {{names}}',
  'gateway-answer-too-large':
    'Ответ контура больше 8 МБ — шлюз не собирает его целиком. Тот же запрос потоком приходит без этого потолка',
  'gateway-not-anthropic': 'Платформа ответила не сообщением диалекта Anthropic',
  'gateway-mask-rules-broken': 'Защита данных включена, а правила не читаются ({{error}})',
  'gateway-mask-unparsed': 'Защита данных не разобрала тело запроса',
  'gateway-mask-blocked':
    'Запрос остановлен правилом «{{rule}}» — в нём нашлись данные, которые не должны уходить в модель',
  'gateway-mask-unrestorable':
    'Вызов инструмента остановлен: метку защиты данных {{names}} нечем развернуть — она уехала бы в файл вместо значения',
  'gateway-images-not-declared': 'У контура «{{title}}» ручка картинок манифестом не объявлена',
  'gateway-images-too-large': 'Ответ ручки картинок больше 16 МБ — шлюз его не собирает',
  'gateway-failed': 'AgentDeck: шлюз не смог обработать запрос',
  'gateway-ports-busy': 'порты {{from}}–{{to}} заняты: {{reason}}',
  'gateway-ports-busy-unknown': 'причина неизвестна',
  'gateway-ceiling-cut':
    'Ответ контура оборвался на {{seconds}}-й секунде — это потолок самой платформы на любой ответ, поток тоже. Сеть здесь ни при чём: сократите ход (меньше размышлений, короче ответ) или попросите владельца контура поднять потолок',
  'gateway-url-not-http': 'Адрес контура не http(s): {{url}}',
  'gateway-redirect':
    'Контур ответил перенаправлением ({{status}}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет',
  'gateway-redirect-to':
    'Контур ответил перенаправлением на {{where}} ({{status}}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет',
  'gateway-headers-timeout': 'Контур не начал отвечать за {{seconds}} с',
  'gateway-cert-failed':
    'Сертификат контура не проверился: {{reason}}. Укажите корневой сертификат компании в настройках контура',
  'gateway-no-connection': 'Нет связи с контуром: {{reason}}',
  'gateway-key-not-header-safe':
    'Ключ контура не годится для заголовка: в нём есть символы вне латиницы. Сохраните ключ заново, без лишних символов',
  'gateway-proxy-unsupported':
    'Прокси из {{source}} ({{value}}) панель не умеет: нужен обычный http-прокси. Напрямую в обход названного прокси панель не пойдёт',
  'gateway-proxy-unreachable': 'прокси {{host}} недоступен: {{reason}}',
  'gateway-proxy-connect-timeout': 'прокси {{host}} не ответил на CONNECT за {{seconds}} с',
  'gateway-proxy-connect-refused':
    'прокси {{host}} не пропустил CONNECT к {{authority}}: {{status}}',
  'gateway-proxy-connect-login':
    'прокси {{host}} не пропустил CONNECT к {{authority}}: {{status}} (нужен логин к прокси)',
  'gateway-request-cancelled': 'запрос отменён',
  'gateway-flaw-fenced': 'вызов внутри блока кода не выполняется',
  'gateway-flaw-loose-whole': 'вызов без тега принимается только целым объектом JSON',
  'gateway-flaw-undeclared': 'инструмент не объявлен клиентом',
  'gateway-flaw-args': 'аргументы не разбираются как объект',
  'gateway-flaw-empty': 'пустой блок вызова',
  'gateway-flaw-several': 'несколько вызовов в одном блоке',
  'gateway-flaw-not-json': 'не разбирается как JSON',
  'gateway-flaw-no-object': 'внутри блока нет объекта',
  'gateway-flaw-no-name': 'в блоке нет имени инструмента',
  'gateway-flaw-unclosed': 'блок без закрывающего тега',
  'gateway-flaw-fence-midanswer': 'вызов забором посреди ответа не выполняется',
  'gateway-flaw-contour-unnamed': 'вызов контура без имени',
  'gateway-flaw-contour-args': 'аргументы вызова контура не разбираются',
  'gateway-flaw-stop-without-call': 'причина остановки «вызов» без единого вызова',
  'gateway-request-aborted': 'Запрос отменён',
  'proxy-failed': 'прокси не смог обработать запрос',
  'proxy-not-configured': 'прокси не настроен',
  'proxy-body-too-large': 'тело запроса слишком велико',
  'proxy-shape-unknown': 'форма запроса не разбирается',
  'proxy-body-not-json': 'тело запроса не JSON',
  'proxy-stopped-unparsed':
    'AgentDeck: {{reason}}, запрос остановлен (настройка «пропускать неразобранное» выключена)',
  'proxy-upstream-unreachable': 'AgentDeck: адрес модели не отвечает ({{reason}})',
};
