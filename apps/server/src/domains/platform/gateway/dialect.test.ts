import { describe, it, expect } from 'vitest';
import { enterprisePlatformDriver } from '../drivers/enterprise-platform.ts';
import { openAiCompatDriver } from '../drivers/openai-compat.ts';
import {
  DIALECT_TABLE,
  anthropicRequestToOpenAi,
  errorBody,
  openAiModelsToAnthropic,
  openAiRequestLoss,
  openAiResponseToAnthropic,
  stopReasonOf,
  upstreamErrorCode,
} from './dialect.ts';

/**
 * Перевод диалектов — самая опасная часть шлюза, и проверяется он ТАБЛИЦЕЙ:
 * каждая строка соответствий прогоняется отдельным случаем.
 *
 * Смысл именно в обходе таблицы, а не в наборе примеров: строка, которую забыли
 * реализовать, и поле, которое переносится молча вопреки записи «не
 * переносится», ловятся только так. Ошибка здесь не падает — она тихо теряет
 * половину запроса, и человек считает, что модель видела то, чего не видела.
 */

/** Запрос, в котором есть ВСЁ, о чём говорит таблица. */
function fullRequest() {
  return {
    model: 'gpt-x',
    system: 'системная строка',
    messages: [
      { role: 'user', content: 'привет' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ответ', cache_control: { type: 'ephemeral' } },
          { type: 'thinking', thinking: 'размышление', signature: 'sig' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'document', source: { type: 'base64', data: 'PDF' } },
          { type: 'tool_result', tool_use_id: 'x', content: 'итог' },
        ],
      },
    ],
    max_tokens: 100,
    temperature: 0.4,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ['СТОП'],
    stream: true,
    metadata: { user_id: 'кто-то' },
    tools: [{ name: 'Read' }],
    tool_choice: { type: 'auto' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
  };
}

describe('таблица соответствий диалектов', () => {
  it('в таблице нет пустых строк и повторов', () => {
    const names = DIALECT_TABLE.map((row) => row.anthropic);
    expect(new Set(names).size).toBe(names.length);
    for (const row of DIALECT_TABLE) {
      expect(row.anthropic).not.toBe('');
      // У «не переносится» имени в чужом диалекте нет — иначе строка врёт.
      if (row.fate === 'dropped') expect(row.openai).toBe('');
      else expect(row.openai).not.toBe('');
      expect(row.note.length + (row.fate === 'mapped' ? 1 : 0)).toBeGreaterThan(0);
    }
  });

  it.each(DIALECT_TABLE.filter((row) => row.fate === 'dropped'))(
    'не переносится: $anthropic',
    (row) => {
      const { body, lost } = anthropicRequestToOpenAi(
        fullRequest(),
        enterprisePlatformDriver.requestFields,
      );
      const text = JSON.stringify(body);

      // Названо потерей — и НЕ уехало наверх ни под каким именем.
      expect(lost.map((item) => item.field)).toContain(row.anthropic);
      const key = row.anthropic.replace('content[].', '').split(' ')[0];
      expect(text).not.toContain(`"${key}"`);
    },
  );

  it('каждая перенесённая строка доезжает под своим именем', () => {
    const { body } = anthropicRequestToOpenAi(
      fullRequest(),
      enterprisePlatformDriver.requestFields,
    );
    expect(body.model).toBe('gpt-x');
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(['СТОП']);
    expect(body.stream).toBe(true);
    expect(body.user).toBe('кто-то');
  });

  it('системная строка становится первой репликой с ролью system', () => {
    const { body } = anthropicRequestToOpenAi(
      fullRequest(),
      enterprisePlatformDriver.requestFields,
    );
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'системная строка' });
  });

  it('система массивом блоков: текст доезжает, потеря названа', () => {
    const { body, lost } = anthropicRequestToOpenAi(
      {
        model: 'm',
        system: [
          { type: 'text', text: 'первый' },
          { type: 'text', text: 'второй', cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: 'вопрос' }],
      },
      enterprisePlatformDriver.requestFields,
    );
    const messages = body.messages as { role: string; content: string }[];
    // Текст системного промпта ТЕРЯТЬ НЕЛЬЗЯ: молча выкинутые указания агенту
    // хуже любой названной потери. Теряется разметка блоков, а не смысл.
    expect(messages.at(0)?.content).toBe('первый\n\nвторой');
    expect(lost.map((item) => item.field)).toContain('system[] (массив блоков)');
    expect(lost.map((item) => item.field)).toContain('cache_control');
  });

  it('картинка переносится data-адресом', () => {
    const { body } = anthropicRequestToOpenAi(
      fullRequest(),
      enterprisePlatformDriver.requestFields,
    );
    const messages = body.messages as { role: string; content: unknown }[];
    const withImage = messages.at(-1)?.content as { type: string; image_url?: { url: string } }[];
    expect(withImage[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    });
  });

  it('реплика, от которой ничего не осталось, не отправляется', () => {
    const { body } = anthropicRequestToOpenAi(
      {
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'итог' }] },
          { role: 'user', content: 'настоящий вопрос' },
        ],
      },
      enterprisePlatformDriver.requestFields,
    );
    // Контур отвергает пустое содержимое схемой — отправить такую реплику
    // значило бы получить 422 вместо ответа.
    expect(body.messages).toEqual([{ role: 'user', content: 'настоящий вопрос' }]);
  });

  it('каждая потеря названа один раз, даже если поле встретилось трижды', () => {
    const { lost } = anthropicRequestToOpenAi(
      {
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'document', source: {} }] },
          { role: 'user', content: [{ type: 'document', source: {} }] },
        ],
      },
      enterprisePlatformDriver.requestFields,
    );
    expect(lost.filter((item) => item.field === 'content[].document')).toHaveLength(1);
    expect(lost.at(0)?.note).not.toBe('');
  });

  it('мусор вместо тела не роняет мост', () => {
    expect(anthropicRequestToOpenAi(null, enterprisePlatformDriver.requestFields).body).toEqual({});
    expect(anthropicRequestToOpenAi('строка', enterprisePlatformDriver.requestFields).lost).toEqual(
      [],
    );
  });
});

/**
 * Инструменты полем (`clientTools: 'native'`, аудит DRV-01). Проверяется
 * история ХОДА целиком, а не одна схема: агент, у которого прошлый вызов уехал
 * без своего результата, вызывает инструмент второй раз, а строгий шлюз
 * отвергает роль `tool`, стоящую не сразу за вызовами.
 */
describe('инструменты клиента полем', () => {
  const NATIVE = { mode: 'native' } as const;

  function turn() {
    return {
      model: 'qwen',
      system: 'ты агент',
      tools: [
        {
          name: 'Write',
          description: 'пишет файл',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
        { name: 'Read', input_schema: { type: 'object' } },
      ],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: 'перепиши a.ts' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'читаю' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'старое' },
            { type: 'text', text: 'дальше' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              is_error: true,
              content: [
                { type: 'text', text: 'нет прав' },
                { type: 'image', source: {} },
              ],
            },
          ],
        },
      ],
    };
  }

  it('схемы становятся функциями, выбор — значением диалекта OpenAI', () => {
    const { body, lost, tools, shimmed } = anthropicRequestToOpenAi(
      turn(),
      openAiCompatDriver.requestFields,
      NATIVE,
    );
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'Write',
          description: 'пишет файл',
          parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      },
      { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
    ]);
    expect(body.tool_choice).toBe('required');
    expect(body.parallel_tool_calls).toBe(false);
    // Разбирать ответ прослойке нечего: вызов приедет полем, а не текстом.
    expect(tools).toEqual([]);
    expect(shimmed).toEqual([]);
    expect(lost.map((item) => item.field)).not.toContain('tools');
  });

  it('вызовы и результаты доезжают упаковкой OpenAI, результат — сразу за вызовом', () => {
    const { body, lost } = anthropicRequestToOpenAi(
      turn(),
      openAiCompatDriver.requestFields,
      NATIVE,
    );
    expect(body.messages).toEqual([
      { role: 'system', content: 'ты агент' },
      { role: 'user', content: 'перепиши a.ts' },
      {
        role: 'assistant',
        content: 'читаю',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'старое' },
      { role: 'user', content: 'дальше' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_2', type: 'function', function: { name: 'Write', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_2', content: 'ошибка: нет прав' },
    ]);
    // Картинку роль `tool` не несёт — и это названо, а не выброшено молча.
    expect(lost.map((item) => item.field)).toEqual(['content[].tool_result (внутри картинка)']);
  });

  it.each([
    [{ type: 'auto' }, 'auto'],
    [{ type: 'none' }, 'none'],
    [
      { type: 'tool', name: 'Read' },
      { type: 'function', function: { name: 'Read' } },
    ],
  ])('выбор %j → %j', (choice, expected) => {
    const { body } = anthropicRequestToOpenAi(
      { ...turn(), tool_choice: choice },
      openAiCompatDriver.requestFields,
      NATIVE,
    );
    expect(body.tool_choice).toEqual(expected);
    expect(body).not.toHaveProperty('parallel_tool_calls');
  });

  it('серверный инструмент вендора назван потерей, выбор без `tools` не уходит', () => {
    const { body, lost } = anthropicRequestToOpenAi(
      {
        model: 'qwen',
        messages: [{ role: 'user', content: 'найди' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        tool_choice: { type: 'auto' },
      },
      openAiCompatDriver.requestFields,
      NATIVE,
    );
    expect(body).not.toHaveProperty('tools');
    // Строгий шлюз отвергает `tool_choice` без `tools` запросом целиком.
    expect(body).not.toHaveProperty('tool_choice');
    expect(lost.map((item) => item.field)).toEqual([
      'tools (серверные инструменты вендора)',
      'tool_choice',
    ]);
    for (const item of lost) expect(item.note.trim()).not.toBe('');
  });
});

describe('ответ контура → ответ Anthropic', () => {
  const completion = {
    id: 'chatcmpl-1',
    model: 'gpt-x',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'ответ' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  };

  it('текст, причина остановки и расход переименовываются', () => {
    const body = openAiResponseToAnthropic(completion, 'запасная') as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content).toEqual([{ type: 'text', text: 'ответ' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  it('модель берётся из ответа, а при её отсутствии — из запроса', () => {
    const body = openAiResponseToAnthropic({ choices: [] }, 'запасная') as Record<string, unknown>;
    expect(body.model).toBe('запасная');
    expect(body.content).toEqual([{ type: 'text', text: '' }]);
  });

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['content_filter', 'end_turn'],
    ['неизвестное', 'end_turn'],
    [undefined, 'end_turn'],
  ])('причина остановки %s → %s', (from, to) => {
    expect(stopReasonOf(from, 0)).toBe(to);
  });

  it('tool_use — только рядом с вызовом, и вызов перебивает любую причину', () => {
    expect(stopReasonOf('tool_calls', 1)).toBe('tool_use');
    expect(stopReasonOf('stop', 2)).toBe('tool_use');
    // Причина «вызов» без единого блока: сообщение, в котором клиент ждёт вызов,
    // которого нет, и ход повисает.
    expect(stopReasonOf('tool_calls', 0)).toBe('end_turn');
  });

  it('цельный ответ с причиной «вызов», но без вызова, не объявляет tool_use', () => {
    const body = openAiResponseToAnthropic(
      { choices: [{ index: 0, message: { content: 'нет вызова' }, finish_reason: 'tool_calls' }] },
      'm',
    ) as Record<string, unknown>;
    expect(body.stop_reason).toBe('end_turn');
  });
});

describe('ошибка внутри потока — к коду моста', () => {
  it.each([
    // платформа компании: тип выведен из статуса, различает только code (provider_errors.py)
    [
      { message: 'x', type: 'invalid_request_error', code: 'content_policy' },
      'content_policy_violation',
    ],
    [{ message: 'x', type: 'rate_limit_error', code: 'rate_limit' }, 'rate_limit_error'],
    [
      { message: 'x', type: 'invalid_request_error', code: 'context_length_exceeded' },
      'invalid_request_error',
    ],
    [{ message: 'x', type: 'server_error', code: 'registry_not_loaded' }, 'overloaded_error'],
    [{ message: 'x', type: 'server_error', code: 'timeout' }, 'api_error'],
    // OpenRouter: code — статус числом
    [{ message: 'x', code: 502 }, 'api_error'],
    [{ message: 'x', code: 429 }, 'rate_limit_error'],
    [{ message: 'x', code: 402 }, 'billing_error'],
    // OpenAI
    [{ message: 'x', type: 'insufficient_quota', code: null }, 'billing_error'],
    [{ message: 'x' }, 'api_error'],
  ])('%j → %s', (error, code) => {
    expect(upstreamErrorCode(error)).toBe(code);
  });

  it('тип OpenAI-ошибки называет беду, а не всегда «исправьте запрос»', () => {
    const type = (code: string): unknown =>
      (errorBody('openai-compat', 'm', code) as { error: { type: string } }).error.type;
    expect(type('rate_limit_error')).toBe('rate_limit_error');
    expect(type('api_error')).toBe('server_error');
    expect(type('overloaded_error')).toBe('server_error');
    expect(type('authentication_error')).toBe('authentication_error');
    expect(type('billing_error')).toBe('insufficient_quota');
    expect(type('content_policy_violation')).toBe('invalid_request_error');
  });
});

describe('отказ в форме диалекта', () => {
  it('anthropic получает свою форму ошибки', () => {
    expect(errorBody('anthropic', 'причина', 'authentication_error')).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'причина' },
    });
  });

  it('openai получает свою', () => {
    expect(errorBody('openai-compat', 'причина', 'content_policy_violation')).toEqual({
      error: {
        message: 'причина',
        type: 'invalid_request_error',
        code: 'content_policy_violation',
      },
    });
  });

  it('незнакомый код становится обычной ошибкой запроса, а не выдумкой', () => {
    const body = errorBody('anthropic', 'причина', 'что-то_своё') as {
      error: { type: string };
    };
    expect(body.error.type).toBe('invalid_request_error');
  });
});

describe('потери в диалекте самого контура', () => {
  const dropped = enterprisePlatformDriver.requestFields.filter(
    (row) => row.dialect === 'openai' && row.field !== 'tool_choice',
  );

  it.each(dropped.map((row) => row.field))('поле %s названо потерей', (field) => {
    // Перевода тут нет вовсе, а потеря есть: контур принимает эти поля схемой и
    // до модели не доносит (справочник §5). Молча — то есть ровно так, как
    // выглядит работающая настройка.
    const lost = openAiRequestLoss(
      { model: 'm', [field]: 'что-нибудь' },
      enterprisePlatformDriver.requestFields,
    );
    expect(lost.map((item) => item.field)).toEqual([field]);
    expect(lost[0]?.note).not.toBe('');
  });

  it('чего клиент не присылал, того и не потерял', () => {
    expect(
      openAiRequestLoss(
        { model: 'm', messages: [], temperature: 0.2 },
        enterprisePlatformDriver.requestFields,
      ),
    ).toEqual([]);
  });

  it('tool_choice: "none" — единственное значение, которое у контура работает', () => {
    expect(
      openAiRequestLoss({ tool_choice: 'none' }, enterprisePlatformDriver.requestFields),
    ).toEqual([]);
    expect(
      openAiRequestLoss({ tool_choice: 'auto' }, enterprisePlatformDriver.requestFields).map(
        (item) => item.field,
      ),
    ).toEqual(['tool_choice']);
  });
});

describe('список моделей в диалекте anthropic', () => {
  it('форма OpenAI переводится в форму Anthropic', () => {
    const body = openAiModelsToAnthropic({
      object: 'list',
      data: [{ id: 'gpt-x', object: 'model', created: 1_700_000_000 }],
    }) as { data: Record<string, unknown>[]; has_more: boolean };

    expect(body.data[0]).toMatchObject({ type: 'model', id: 'gpt-x', display_name: 'gpt-x' });
    expect(body.has_more).toBe(false);
  });

  it('чужая форма не выдумывается: пустой список остаётся пустым', () => {
    expect(openAiModelsToAnthropic('<html>')).toEqual({ data: [], has_more: false });
  });
});
