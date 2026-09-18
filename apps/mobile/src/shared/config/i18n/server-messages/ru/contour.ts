import type { ContourMessageCode } from '@agentdeck/contracts/server-messages';

export const contourRu: Record<ContourMessageCode, string> = {
  'contour-gateway-not-raised': 'Шлюз не поднялся: {{reason}}',
  'contour-smoke-no-models': 'Контур не назвал ни одной модели: спрашивать нечем.',
  'contour-smoke-gateway-down': 'Шлюз не поднят: пробный запрос идёт через него, как и работа CLI.',
  'contour-smoke-thinking-cap':
    'Модель израсходовала потолок пробного запроса ({{tokens}} токенов), не сказав ни слова, — похоже, всё ушло в размышления. Путь прошёл; у рабочих запросов потолок выше.',
  'contour-smoke-silent': 'Модель не сказала ни слова: путь прошёл, ответа нет.',
  'contour-smoke-timeout': 'Ответа не было {{seconds}} с — столько же прождёт и CLI.',
  'contour-smoke-gateway-error': 'Шлюз не ответил: {{reason}}.',
  'contour-smoke-refused': 'Шлюз ответил {{status}}: {{message}}',
  'contour-smoke-status': 'Шлюз ответил {{status}}.',
  'contour-agent-not-json': 'Контур ответил не JSON — разобрать ответ агента нечем.',
  'contour-agent-unknown-shape':
    'Контур ответил в форме, которую панель не узнала: разбирать нечего.',
  'contour-agent-answered': 'Агент ответил.',
  'contour-agent-empty': 'Агент ответил пустым сообщением.',
  'contour-agent-session-rejected': 'Контур не принял идентификатор сессии (422).',
  'contour-agent-said': '{{message}} Контур сказал: {{detail}}',
  'contour-agent-no-license':
    'Агенты не входят в лицензию этого контура — их включает компания, а не панель.',
  'contour-agent-license-inactive':
    'Лицензия контура неактивна: агенты не работают, пока её не продлят.',
  'contour-agent-license-unchecked':
    'Контур не смог проверить свою лицензию — это его сторона, повторите позже.',
  'contour-agent-key-rejected': 'Ключ отклонён контуром (401): отозван либо исчерпан его бюджет.',
  'contour-agent-key-forbidden': 'Ключу не разрешено звать агентов (403).',
  'contour-agent-key-budget': 'Исчерпан бюджет ключа (402).',
  'contour-agent-not-found':
    'Контур не нашёл такого агента (404). Проверьте идентификатор в админке.',
  'contour-agent-failed': 'Агент завершился ошибкой.',
  'contour-agent-rate-limited': 'Контур ограничил частоту запросов (429).',
  'contour-agent-status': 'Контур ответил ошибкой {{status}}.',
  'contour-agent-rejected': 'Контур не принял запрос ({{status}}).',
  'contour-agent-nothing-to-ask': 'Нечего спрашивать: сообщений нет.',
  'contour-agent-last-must-be-question': 'Последним сообщением должен быть вопрос человека.',
  'contour-agent-no-system-with-session':
    'С сессией системное сообщение не передаётся — контур его не хранит.',
  'contour-probe-not-api': 'Адрес ответил {{status}}, но это не список моделей: {{hint}}.',
  'contour-probe-not-api-address':
    'Адрес ответил {{status}}, но это не список моделей: {{hint}}. {{address}}',
  'contour-probe-bad-url': 'Адрес контура должен быть корректным http(s)-адресом.',
  'contour-probe-no-key':
    'Адрес отвечает как API контура и без ключа отказал ({{status}}) — так и должно быть: ключ ещё не введён. Введите его на следующем шаге.',
  'contour-probe-unauthorized': '{{message}} (401).',
  'contour-probe-forbidden':
    'Ключу не разрешено то, что запросила панель (403). Проверьте права ключа.',
  'contour-probe-not-ready': '{{message}} ({{status}}). Повторите проверку.',
  'contour-probe-server-error':
    'Контур ответил ошибкой {{status}}. Это его сторона — повторите позже.',
  'contour-probe-no-catalog-path': 'список моделей по этому пути не найден',
  'contour-probe-html': 'вернулась HTML-страница, а не JSON',
  'contour-probe-not-json': 'ответ не разбирается как JSON',
  'contour-probe-no-models-field': 'в ответе нет списка моделей (ни поля data, ни массива)',
  'contour-probe-ok': 'Контур ответил: моделей {{count}}.',
  'contour-probe-timeout': 'Контур не ответил за {{seconds}} с.',
  'contour-address-admin':
    'Похоже, это адрес админки: публичный API живёт на отдельном хосте (обычно api.<домен>).',
  'contour-thinking-default': 'по умолчанию',
  'contour-thinking-on': 'включено',
  'contour-thinking-off': 'выключено',
  'contour-where-outside': 'вне панели',
  'contour-conflict-tools-title': 'Инструменты платформы ⟷ наша прослойка инструментов',
  'contour-conflict-tools-detail':
    'Два набора инструментов на один ход: наш едет текстом и собирается обратно из ответа, набор контура исполняет сам контур. Включить оба нельзя — выберите один.',
  'contour-conflict-anonymization-title': 'Подмена данных контура ⟷ наша маска данных',
  'contour-conflict-anonymization-detail':
    'Не выбор из двух: слои складываются по порядку. По API-ключу подмена у контура не гарантирована — проба стенда показала запрос без подмены, а карту подмены клиенту API контур не отдаёт. Поэтому наша маска у такого контура включается сама: она идёт первой, обратима, и её метки контур не трогает. Выключать ничего не нужно.',
  'contour-conflict-anonymization-detail-off':
    'Не выбор из двух: слои складываются по порядку. По API-ключу подмена у контура не гарантирована — проба стенда показала запрос без подмены, а карту подмены клиенту API контур не отдаёт. Наша маска у такого контура включается сама, но СЕЙЧАС она выключена на этой карточке: запрос уедет в контур как есть. Включает переключатель «Маска данных панели» выше.',
  'contour-conflict-compaction-title': 'Сжатие истории контуром ⟷ наши контрольные точки',
  'contour-conflict-compaction-detail':
    'Длинную переписку контур сжимает сам, а контрольная точка панели описывает историю целиком. После сжатия продолжение может не знать начала задачи — держите точку свежей.',
  'contour-conflict-guardrails-title': 'Проверки содержимого контура ⟷ наш гейт промпта',
  'contour-conflict-guardrails-detail':
    'Проверяют оба и по разным спискам: гейт панели откажет до отправки и назовёт правило, контур откажет у себя статусом 451. Второй отказ не означает, что первый не сработал.',
  'contour-control-tools-title': 'Инструменты платформы',
  'contour-control-tools-detail':
    'имена инструментов контура; пусто — наверх уходит «tool_choice: none»',
  'contour-control-toolmode-title': 'Цикл вызовов платформы',
  'contour-control-toolmode-detail':
    '«loop» — контур ходит по кругу сам, «single_turn» — возвращает вызов клиенту; такой ход идёт к контуру не потоком',
  'contour-control-preset-title': 'Пресет генерации',
  'contour-control-preset-detail':
    'именованный набор параметров на стороне контура; пусто — контур берёт свой',
  'contour-control-thinking-title': 'Размышления модели',
  'contour-control-thinking-detail':
    'включить или выключить доходит только до моделей на самохостед vLLM — остальным провайдерам контур поле не передаёт; по умолчанию не отправляется, решает шаблон модели. Размышления наружу не уходят',
  'contour-control-thinking-manifest-detail':
    'включить или выключить полем «{{path}}»; по умолчанию не отправляется, решает шаблон модели',
  'contour-control-guardrails-title': 'Проверки содержимого',
  'contour-control-guardrails-detail': 'включает владелец контура; отказ приходит статусом 451',
  'contour-control-owner-enables': 'включает владелец контура',
  'contour-control-anonymization-title': 'Подмена данных',
  'contour-control-anonymization-detail':
    'есть у собственного чата контура; по API-ключу проба стенда показала запрос БЕЗ подмены, и карту клиенту API контур не отдаёт',
  'contour-control-knowledge-title': 'Знания компании',
  'contour-control-knowledge-where': 'подмешивает владелец ключа',
  'contour-control-knowledge-detail': 'подмешиваются владельцем ключа, отдельного маршрута нет',
  'contour-control-context-title': 'Сжатие истории',
  'contour-control-context-where': 'решает контур',
  'contour-control-context-detail':
    'длинную переписку контур сжимает сам — наши контрольные точки об этом не знают',
  'contour-notes-no-capabilities':
    'Возможности сверх списка моделей у совместимого шлюза не объявлены.',
  'contour-tools-dropped':
    'Тип контура выбрасывает поле инструментов — без прослойки агент не сможет править файлы.',
  'contour-tools-refused': 'Запрос с инструментом отклонён ({{status}}).',
  'contour-tools-call-as-text':
    'Модель написала вызов текстом: поле инструментов до неё не дошло или она его не понимает.',
  'contour-tools-no-call': 'Модель ответила без вызова инструмента.',
  'contour-tools-failed': 'Проба инструментов не прошла: {{reason}}.',
  'contour-required-gateway-down':
    'Контур «{{title}}» обязателен, а шлюз панели не поднят — прогон не запущен, чтобы не уйти в облако вендора. Нажмите «Поднять шлюз» на карточке контура (раздел «Контур») либо верните провайдер по умолчанию.',
  'contour-required-no-token':
    'Контур «{{title}}» обязателен, а ключ контура не сохранён — прогон не запущен, чтобы не уйти в облако вендора. Сохраните ключ («Настроить» на карточке контура → шаг «Ключ») либо верните провайдер по умолчанию.',
  'contour-target-assistant': 'Ассистент панели',
  'contour-bridge-script-missing':
    'Не найден скрипт переходника tools/mcp/platform.mjs — панель запущена не из своего репозитория.',
};
