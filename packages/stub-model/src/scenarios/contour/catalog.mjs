/**
 * Каталог стаб-контура: модели, отказы и сценарии по имени модели. Перенесено из
 * `tools/qa/stub-platform.mjs` без смены провода — свипы панели и тесты ядра говорят с одним
 * и тем же контуром (P120).
 */

/** Пустая картинка 1×1: свипу нужен факт картинки, а не её содержимое. */
export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Каталог моделей. Возможности объявлены полями — ровно так, как их объявляет
 * платформа: панель обязана читать их, а не выводить из имени модели.
 */
export const MODELS = [
  {
    id: 'stub-chat',
    kind: 'chat',
    owned_by: 'stub',
    context_length: 128000,
    max_output_tokens: 4096,
    supports_function_calling: true,
    supports_vision: false,
  },
  { id: 'stub-reasoning', kind: 'chat', owned_by: 'stub', context_length: 64000 },
  { id: 'stub-guardrails', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Модель, которая надиктовывает колоду блоком (Т10): дорога контура у
  // презентаций — это обычный чат, и панель разбирает ответ тем же кодом, каким
  // читает блок из ответа агента.
  { id: 'stub-deck', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-masked', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-tools', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Скриптованная модель прослойки инструментов (Т5.2): первым ходом отвечает
  // вызовом по текстовому протоколу, вторым — обычным текстом.
  { id: 'stub-tool-shim', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  // Две другие формы живой модели среднего класса: ответ ЦЕЛИКОМ забор без метки (обязан
  // довести вызов до файла) и пример протокола посреди ответа (не смеет тронуть файл).
  { id: 'stub-tool-loose', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  { id: 'stub-tool-quote', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  // Вызов, названный самим заданием (П4.2): сверка прав зависит от имени и аргументов.
  { id: 'stub-tool-any', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  // Совместимый шлюз с разборщиком вызовов (vLLM `--tool-call-parser`): вызов ПОЛЕМ `tool_calls`.
  { id: 'stub-tool-native', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  { id: 'stub-image', kind: 'chat', owned_by: 'stub', image_generation: true },
  // Сжатие истории и подмена сущностей панель видит ТОЛЬКО в потоке — без своей модели в
  // каталоге эти сценарии в свипе не звучали вовсе.
  { id: 'stub-summarizing', kind: 'chat', owned_by: 'stub', context_length: 8000 },
  { id: 'stub-anonymized', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Итоговый текст контура разошёлся с отданным потоком (`platform_deanonymized`).
  { id: 'stub-rewritten', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Отказ поставщика объектом `error` ПОСЛЕ заголовков 200 — так делает litellm.
  { id: 'stub-stream-error', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Хвост вызова прослойки приходит ПОСЛЕ причины остановки (придержанный хвост).
  { id: 'stub-tool-tail', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-embed', kind: 'embedding', owned_by: 'stub' },
  { id: 'stub-401', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-402', kind: 'chat', owned_by: 'stub' },
  // Лимит запросов — такой же отказ контура; без модели в каталоге он был недостижим.
  { id: 'stub-429', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-451', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-503', kind: 'chat', owned_by: 'stub' },
];

/** Нарушение в той форме `RuleViolation`, которую отдаёт модуль проверок содержимого платформы. */
export function ruleViolation(ruleName, ruleType, message) {
  return {
    rule_id: `r-${ruleType.toLowerCase()}`,
    rule_name: ruleName,
    rule_type: ruleType,
    action: 'BLOCK',
    mode: 'ENFORCE',
    scope: 'GLOBAL',
    scanner_name: ruleType,
    score: 1,
    message,
    details: {},
  };
}

/**
 * Отказы контура: код и тело в той форме, в какой их разбирает панель. Тела списаны со
 * справочника §8: 402 на `/v1` называет бюджет КЛЮЧА, 451 — перечень сработавших правил.
 */
export const REFUSALS = {
  401: { error: { message: 'invalid API key', type: 'authentication_error' } },
  // Дословно то, что платформа отдаёт на исчерпанный бюджет ключа: панель узнаёт причину по тексту.
  402: {
    error: {
      message: 'budget exceeded for this API key',
      type: 'billing_error',
      code: 'budget_exceeded',
    },
  },
  429: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } },
  // Найденное лежит в `message` сканера — панель его не читает никогда.
  451: {
    error: {
      message: 'Запрос остановлен проверками контента',
      type: 'guardrail_violation',
      code: 'content_policy_violation',
    },
    violations: [
      ruleViolation('Персональные данные', 'ANONYMIZE', 'найдено: Иванов Иван Иванович'),
      ruleViolation(null, 'SECRETS', 'ключ AKIAIOSFODNN7EXAMPLE'),
    ],
  },
  503: { error: { message: 'upstream model is unavailable', type: 'api_error' } },
};

/** `Retry-After` у 429: без него «слишком часто» не отличить от «сломалось» (справочник §8 №9). */
export const REFUSAL_HEADERS = {
  429: { 'retry-after': '12' },
};

export const SCENARIOS = new Set([
  'clean',
  'reasoning',
  'guardrails',
  'masked',
  'summarizing',
  'anonymized',
  'tools',
  'tool-shim',
  'tool-loose',
  'tool-quote',
  'tool-tail',
  'tool-any',
  'tool-native',
  'rewritten',
  'stream-error',
  'image',
  'deck',
  '401',
  '402',
  '429',
  '451',
  '503',
]);

/** Имя модели → сценарий. Неизвестное имя — это умолчание стаба, а не отказ. */
export function scenarioFor(model, fallback) {
  const name = String(model ?? '');
  const tail = name.startsWith('stub-') ? name.slice('stub-'.length) : '';
  return SCENARIOS.has(tail) ? tail : fallback;
}

/**
 * Модель в форме каталога OpenRouter. Цена есть только у `stub-chat`, и она круглая — доллар
 * за токен, — чтобы деньги сверялись без округлений; у остальных `"-1"`, «неизвестно».
 */
export function openRouterModel({ id, context_length }) {
  return {
    id,
    name: id,
    context_length,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'max_tokens'],
    top_provider: { context_length, max_completion_tokens: 2048 },
    pricing:
      id === 'stub-chat' ? { prompt: '1', completion: '1' } : { prompt: '-1', completion: '-1' },
  };
}

/** Колода, которую «надиктовала» модель контура; завёрнута в блок, как у живой модели. */
export const DECK_JSON = {
  title: 'Отчёт о работе панели',
  subtitle: 'проверка на проводе',
  slides: [
    { title: 'Что сделано', bullets: ['режимы', 'колода'], notes: 'заметка докладчику' },
    { title: 'Что дальше', bullets: ['ревью'], notes: '' },
  ],
};

/** Текст ответа с колодой: блок как есть, вместе с оградой. */
export function deckText() {
  return ['```agentdeck:deck', JSON.stringify(DECK_JSON), '```'].join('\n');
}

/** Итоговый текст сценария `rewritten`: с восстановленным значением вместо метки. */
export const REWRITTEN_FINAL = 'Пишите на ivan@example.ru';

/** Текст родной ручки Anthropic (vLLM, LiteLLM, Ollama, OpenRouter — DRV-03). */
export const NATIVE_TEXT = 'ответ родной ручки';
