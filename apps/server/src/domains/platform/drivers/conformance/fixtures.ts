/**
 * Фикстуры набора соответствия: один и тот же материал для всех драйверов.
 *
 * Общие они намеренно. Драйвер, которому для прохождения таблицы нужен СВОЙ
 * ответ списка моделей, отличается от остальных ровно тем, что панель обязана
 * знать про него отдельно, — и тогда это видно сразу, а не после первого
 * запроса живого человека.
 */

/** Ответ списка моделей OpenAI-формы: чат с окном и эмбеддинги без флагов. */
export const MODELS_ANSWER = {
  data: [
    { id: 'chat-one', kind: 'chat', context_length: 32000, max_output_tokens: 4096 },
    { id: 'embed-one', kind: 'embedding' },
  ],
};

/** Обычный чанк потока: его вендорный разбор трогать не вправе. */
export const DELTA_FRAME = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: 'привет' } }],
});

/** Последний чанк со счётом токенов — тоже обычный. */
export const USAGE_FRAME = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
});

/**
 * Чанк, в котором рядом с текстом приехала картинка. В диалекте Anthropic мост
 * её не переносит — и обязан назвать; проверяется это на РЕАЛЬНОМ разборщике,
 * потому что «часть молча обнулилась» видно только по его выходу.
 */
export const IMAGE_DELTA_FRAME = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [
    {
      index: 0,
      delta: {
        content: [
          { type: 'text', text: 'вот схема' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    },
  ],
});

/**
 * Секрет, который контур мог положить в тело отказа по содержимому. Ни один
 * прогон набора не вправе вынести его ни клиенту, ни в панель.
 */
export const SECRET_IN_BODY = 'AKIAIOSFODNN7EXAMPLE';

/** Запрос Anthropic с инструментами: на нём проверяется судьба `tools`. */
export const ANTHROPIC_REQUEST_WITH_TOOLS = {
  model: 'chat-one',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'посчитай' }],
  tools: [{ name: 'calc', description: 'счёт', input_schema: { type: 'object' } }],
  tool_choice: { type: 'auto' },
};
