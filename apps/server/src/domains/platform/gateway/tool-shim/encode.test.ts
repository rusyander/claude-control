import { describe, expect, it } from 'vitest';
import { encodeToolResult, encodeToolUse, shimOpenAiRequest, toolNamesById } from './encode.ts';

/**
 * Путь наверх. Проверяется не «текст собрался», а СЛЕД РАЗГОВОРА: вызов и его
 * результат обязаны доехать до модели вместе. Агент, у которого из прошлого
 * хода пропал результат, записывает файл второй раз — и это худшая из потерь,
 * потому что она выглядит как работа.
 */

const PROTOCOL = 'правила протокола';

describe('следы вызовов в истории', () => {
  it('имя инструмента для результата берётся из самого разговора', () => {
    const names = toolNamesById([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} }],
      },
    ]);
    const { text } = encodeToolResult({ tool_use_id: 'toolu_1', content: 'ok' }, names);
    expect(text).toContain('<tool_result name="Write">');
    expect(text).toContain('ok');
  });

  it('результат неизвестного вызова не выдумывает имя, а называет идентификатор', () => {
    const { text } = encodeToolResult({ tool_use_id: 'toolu_9', content: 'ok' }, new Map());
    expect(text).toContain('<tool_result name="toolu_9">');
  });

  it('ошибка инструмента остаётся ошибкой', () => {
    const { text } = encodeToolResult(
      { tool_use_id: 'x', content: 'нет такого файла', is_error: true },
      new Map(),
    );
    expect(text).toContain('ошибка: нет такого файла');
  });

  it('картинка внутри результата названа потерей, а не выброшена молча', () => {
    const { text, dropped } = encodeToolResult(
      { tool_use_id: 'x', content: [{ type: 'text', text: 'вот' }, { type: 'image' }] },
      new Map(),
    );
    expect(text).toContain('вот');
    expect(dropped).toBe(true);
  });

  it('вызов пишется ровно той грамматикой, которую разбирает разборщик', () => {
    expect(encodeToolUse('Write', { file_path: 'a.ts' })).toBe(
      '<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>',
    );
  });
});

describe('запрос в диалекте OpenAI', () => {
  function request() {
    return {
      model: 'qwen',
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: 'ты агент' },
        { role: 'user', content: 'создай файл' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'Write', arguments: '{"file_path":"a.ts"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok: 12 bytes' },
      ],
    };
  }

  it('инструменты уходят с поля `tools` в системную строку', () => {
    const { body, tools } = shimOpenAiRequest(request(), PROTOCOL);
    expect(body.tools).toBeUndefined();
    expect(tools.map((tool) => tool.name)).toEqual(['Write']);
    const system = (body.messages as Record<string, unknown>[])[0];
    expect(String(system?.content)).toContain('ты агент');
    expect(String(system?.content)).toContain(PROTOCOL);
    expect(String(system?.content)).toContain('### Write');
  });

  it('свои инструменты платформы остаются выключенными', () => {
    // Включённый набор платформы перебивал бы протокол, которому мы только что
    // научили модель (Т7 отдаёт этот выключатель человеку).
    expect(shimOpenAiRequest(request(), PROTOCOL).body.tool_choice).toBe('none');
  });

  it('прошлый вызов сворачивается в текст того же протокола', () => {
    const messages = shimOpenAiRequest(request(), PROTOCOL).body.messages as Record<
      string,
      unknown
    >[];
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.tool_calls).toBeUndefined();
    expect(String(assistant?.content)).toContain(
      '<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>',
    );
  });

  it('роли `tool` у контура нет — результат становится репликой пользователя', () => {
    const messages = shimOpenAiRequest(request(), PROTOCOL).body.messages as Record<
      string,
      unknown
    >[];
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(String(last?.content)).toContain('<tool_result name="Write">');
    expect(String(last?.content)).toContain('ok: 12 bytes');
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('без системной реплики добавка становится первой', () => {
    const { body } = shimOpenAiRequest(
      { messages: [{ role: 'user', content: 'привет' }], tools: [{ function: { name: 'Read' } }] },
      PROTOCOL,
    );
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content)).toContain(PROTOCOL);
  });

  it('клиент не объявил инструментов — в системную строку не дописывается ничего', () => {
    const { body } = shimOpenAiRequest(
      { messages: [{ role: 'system', content: 'ты агент' }] },
      PROTOCOL,
    );
    const messages = body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('ты агент');
  });

  it('остальные поля запроса не трогаются', () => {
    const { body } = shimOpenAiRequest({ ...request(), temperature: 0.2, stream: true }, PROTOCOL);
    expect(body.model).toBe('qwen');
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(true);
  });
});
