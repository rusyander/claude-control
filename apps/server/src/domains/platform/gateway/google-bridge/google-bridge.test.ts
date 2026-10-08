import { describe, it, expect } from 'vitest';
import {
  GoogleStreamBridge,
  chatCompletionToGoogle,
  googleError,
  googleRequestToChat,
  parseGooglePath,
} from './google-bridge.ts';

/**
 * Перевод диалекта Gemini на краю шлюза. Формы запросов — те, что шлёт
 * gemini 0.62 (живая проба 07.10.2026); что настоящий CLI принимает ответ,
 * доказывает только живой прогон (`tools/qa/check-gemini-contour.mjs`).
 */

const frames = (sse: string): Record<string, unknown>[] =>
  sse
    .split('\r\n\r\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);

describe('путь Gemini', () => {
  it('модель с косой чертой и метод — из пути', () => {
    expect(
      parseGooglePath('/v1beta/models/Qwen/Qwen3.8-27B:streamGenerateContent?alt=sse'),
    ).toEqual({ model: 'Qwen/Qwen3.8-27B', method: 'streamGenerateContent' });
    expect(parseGooglePath('/v1beta/models/gemini%2Dx:countTokens')).toEqual({
      model: 'gemini-x',
      method: 'countTokens',
    });
    expect(parseGooglePath('/v1/models')).toBeUndefined();
  });
});

describe('запрос Gemini → chat/completions', () => {
  it('системный текст, ход с вызовом, ответ функции и инструменты — как шлёт gemini 0.62', () => {
    const bridged = googleRequestToChat(
      {
        systemInstruction: { parts: [{ text: 'Ты — агент.' }] },
        contents: [
          { role: 'user', parts: [{ text: 'запиши файл' }] },
          {
            role: 'model',
            parts: [
              { text: 'думаю', thought: true },
              {
                functionCall: { name: 'write_file', args: { file_path: 'a.txt' } },
                thoughtSignature: 'sig',
              },
            ],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'write_file', response: { output: 'ok' } } }],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'write_file',
                description: 'пишет файл',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { file_path: { type: 'string' } },
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 1,
          topP: 0.95,
          topK: 64,
          thinkingConfig: { includeThoughts: true },
        },
      },
      'stub-chat',
      true,
    );
    if (!bridged || 'refusal' in bridged) throw new Error('не переведён');
    const messages = bridged.chat.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: 'system', content: 'Ты — агент.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'запиши файл' });
    // Рассуждение модели не уходит контуру текстом ответа.
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"file_path":"a.txt"}' },
        },
      ],
    });
    // Ответ без id привязан к вызову того же имени.
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });
    expect(bridged.chat).toMatchObject({
      model: 'stub-chat',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 1,
      top_p: 0.95,
      tools: [
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'пишет файл',
            parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
          },
        },
      ],
    });
    expect(bridged.dropped).toContain('generationConfig:thinkingConfig');
  });

  it('схема OpenAPI с заглавными типами переводится в JSON Schema, режим ANY — required', () => {
    const bridged = googleRequestToChat(
      {
        contents: [{ role: 'user', parts: [{ text: 'x' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'f', parameters: { type: 'OBJECT', properties: { a: { type: 'STRING' } } } },
            ],
          },
          { googleSearch: {} },
        ],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
      'm',
      false,
    );
    if (!bridged || 'refusal' in bridged) throw new Error('не переведён');
    expect(
      (bridged.chat.tools as { function: { parameters: unknown } }[])[0]?.function.parameters,
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(bridged.chat.tool_choice).toBe('required');
    expect(bridged.chat.stream).toBe(false);
    expect(bridged.dropped).toContain('tool:googleSearch');
  });

  it('картинка частью inlineData — image_url с data-адресом', () => {
    const bridged = googleRequestToChat(
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'что тут' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
          },
        ],
      },
      'm',
      true,
    );
    if (!bridged || 'refusal' in bridged) throw new Error('не переведён');
    expect((bridged.chat.messages as unknown[])[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'что тут' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });

  it('без contents — не запрос; без единого сообщения — отказ', () => {
    expect(googleRequestToChat({ model: 'x' }, 'm', true)).toBeUndefined();
    expect(googleRequestToChat({ contents: [] }, 'm', true)).toHaveProperty('refusal');
  });
});

describe('поток chat/completions → поток Gemini', () => {
  it('текст кусками сразу, итог с finishReason и расходом в конце', () => {
    const bridge = new GoogleStreamBridge();
    const sse =
      bridge.push('data: {"choices":[{"index":0,"delta":{"content":"гот"}}]}\n\n') +
      bridge.push(
        'data: {"choices":[{"index":0,"delta":{"content":"ов"},"finish_reason":"stop"}]}\n\n',
      ) +
      bridge.push(
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n',
      );
    const out = frames(sse);
    expect(out.map((frame) => JSON.stringify(frame))).toEqual([
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'гот' }] }, index: 0 }],
      }),
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ов' }] }, index: 0 }],
      }),
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
    ]);
    expect(bridge.end()).toBe('');
  });

  it('вызов функции, пришедший дельтами, уходит целым с id контура', () => {
    const bridge = new GoogleStreamBridge();
    const sse =
      bridge.push(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"write_file","arguments":"{\\"file_"}}]}}]}\n',
      ) +
      bridge.push(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}\n',
      ) +
      bridge.end();
    expect(frames(sse)).toEqual([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'c9', name: 'write_file', args: { file_path: 'a' } } }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      },
    ]);
  });

  it('обрыв по длине — MAX_TOKENS; ошибка посреди потока — ошибка Google', () => {
    const cut = new GoogleStreamBridge();
    const end = frames(
      cut.push(
        'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"length"}]}\n',
      ) + cut.end(),
    ).at(-1) as { candidates: { finishReason: string }[] };
    expect(end.candidates[0]?.finishReason).toBe('MAX_TOKENS');

    const failed = new GoogleStreamBridge();
    expect(frames(failed.push('data: {"error":{"message":"правило"}}\n'))).toEqual([
      { error: { code: 500, message: 'правило', status: 'INTERNAL' } },
    ]);
    expect(failed.end()).toBe('');
  });

  it('пустой ответ всё равно несёт часть: пустого кандидата CLI не принимает', () => {
    const bridge = new GoogleStreamBridge();
    expect(frames(bridge.push('data: [DONE]\n'))[0]).toMatchObject({
      candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
    });
  });
});

describe('цельный ответ и отказ', () => {
  it('chat-ответ с текстом и вызовом — один кандидат generateContent', () => {
    expect(
      chatCompletionToGoogle({
        choices: [
          {
            message: {
              content: 'пишу',
              tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    ).toEqual({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'пишу' }, { functionCall: { id: 'c1', name: 'f', args: { a: 1 } } }],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    });
  });

  it('статус отказа сохраняется, имя статуса — из словаря Google API', () => {
    expect(googleError(429, 'лимит')).toEqual({
      error: { code: 429, message: 'лимит', status: 'RESOURCE_EXHAUSTED' },
    });
    expect(googleError(502, 'нет связи').error).toMatchObject({ status: 'INTERNAL' });
  });
});
