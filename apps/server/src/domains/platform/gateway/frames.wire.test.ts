import { describe, it, expect } from 'vitest';
import { enterprise-platformDriver } from '../drivers/enterprise-platform.ts';
import { openAiCompatDriver } from '../drivers/openai-compat.ts';
import { StreamTranslator, TRUNCATED_MESSAGE, type TranslatorOptions } from './frames.ts';

/**
 * Поток в тех формах, в которых его РЕАЛЬНО шлёт та сторона.
 *
 * Каждый кадр здесь списан с источника, а не придуман под разборщик: LiteLLM
 * 1.93 (им платформа компании ходит к модели), `mod-llmbox` платформа компании @ eb18684f5 и
 * документированный кадр ошибки OpenRouter. Разборщик, проверенный на кадрах,
 * собранных «как удобно», зеленел и тогда, когда живой контур отдавал нулевой
 * расход и терял хвост ответа (замер 13.09.2026 на стенде).
 */

function sse(...frames: unknown[]): string {
  return frames
    .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
    .join('');
}

function translator(options: Partial<TranslatorOptions> = {}): StreamTranslator {
  return new StreamTranslator({
    driver: enterprise-platformDriver,
    dialect: 'openai-compat',
    model: 'qwen',
    includeUsage: false,
    ...options,
  });
}

function text(content: string, finish?: string): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'qwen',
    choices: [{ index: 0, delta: { content }, ...(finish ? { finish_reason: finish } : {}) }],
  };
}

/**
 * Последний чанк LiteLLM: расход лежит РЯДОМ с непустым `choices`
 * (`CustomStreamWrapper.model_response_creator`), платформа компании пересылает его как есть
 * (`router.py:894–964`).
 */
const LITELLM_USAGE = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: 'qwen',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
};

describe('расход в чанке с непустым choices', () => {
  it('считается, а не обнуляется', () => {
    const t = translator();
    const out = t.push(sse(text('да'), LITELLM_USAGE, '[DONE]')) + t.end();
    expect(t.facts.promptTokens).toBe(900);
    expect(t.facts.totalTokens).toBe(940);
    // Клиент расход не просил — полем он к нему не едет и здесь.
    expect(out).not.toContain('"usage"');
  });

  it('доезжает до message_delta клиента Anthropic', () => {
    const t = translator({ dialect: 'anthropic' });
    const out = t.push(sse(text('да'), LITELLM_USAGE, '[DONE]')) + t.end();
    const delta = out.slice(out.indexOf('event: message_delta'));
    expect(delta).toContain('"input_tokens":900');
    expect(delta).toContain('"output_tokens":40');
  });

  it('с прослойкой уходит клиенту после причины остановки и до [DONE]', () => {
    const t = translator({ includeUsage: true, shim: { allowed: new Set(['Write']) } });
    const out = t.push(sse(text('готово'), LITELLM_USAGE, '[DONE]')) + t.end();
    expect(t.facts.totalTokens).toBe(940);
    const finish = out.indexOf('"finish_reason":"stop"');
    const usage = out.indexOf('"total_tokens":940');
    expect(finish).toBeGreaterThan(-1);
    expect(usage).toBeGreaterThan(finish);
    expect(out.indexOf('[DONE]')).toBeGreaterThan(usage);
  });
});

describe('ошибка внутри потока', () => {
  /** `provider_errors.py sse_error_event`: конверт ошибки и БЕЗ `[DONE]` за ним. */
  const ENTERPRISE_PLATFORM_ERROR = {
    error: {
      message: 'Превышен лимит запросов к провайдеру. Попробуйте позже.',
      type: 'rate_limit_error',
      code: 'rate_limit',
    },
  };

  it('openai получает причину контура и её тип, а не «ответ оборвался»', () => {
    const t = translator();
    const out = t.push(sse(text('нач'), ENTERPRISE_PLATFORM_ERROR)) + t.end();
    expect(out).toContain('Превышен лимит запросов к провайдеру');
    expect(out).toContain('"type":"rate_limit_error"');
    expect(out).not.toContain(TRUNCATED_MESSAGE);
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(t.facts.truncated).toBe(false);
    expect(t.facts.upstreamError).toEqual({
      code: 'rate_limit_error',
      message: 'Превышен лимит запросов к провайдеру. Попробуйте позже.',
    });
  });

  it('anthropic получает event: error своего типа', () => {
    const t = translator({ dialect: 'anthropic' });
    const out = t.push(sse(text('нач'), ENTERPRISE_PLATFORM_ERROR)) + t.end();
    expect(out).toContain('event: error');
    expect(out).toContain('"type":"rate_limit_error"');
    expect(out).toContain('Превышен лимит');
    expect(out).not.toContain('message_stop');
  });

  it('ошибка OpenRouter с finish_reason "error" не читается удачным концом', () => {
    const t = translator({ dialect: 'anthropic', driver: openAiCompatDriver });
    const chunk = {
      id: 'gen-1',
      object: 'chat.completion.chunk',
      error: { code: 502, message: 'Provider disconnected' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    };
    const out = t.push(sse(text('половина'), chunk, '[DONE]')) + t.end();
    expect(out).toContain('event: error');
    expect(out).toContain('Provider disconnected');
    expect(out).not.toContain('end_turn');
    expect(t.facts.upstreamError?.code).toBe('api_error');
  });

  it('finish_reason "error" без конверта — тоже ошибка, а не законченный ответ', () => {
    const t = translator({ dialect: 'anthropic', driver: openAiCompatDriver });
    const out = t.push(sse(text('половина', 'error'), '[DONE]')) + t.end();
    expect(out).toContain('event: error');
    expect(out).not.toContain('end_turn');
  });
});

describe('хвост ответа после причины остановки (гейт проверок вывода)', () => {
  // `router.py:988–996`: придержанный гейтом хвост и хвост деанонимизатора
  // уходят ПОСЛЕ чанка с `finish_reason`, но до `[DONE]`.
  const head = text('Пишу файл.\n<tool_call>{"name":"Write","arguments":', 'stop');
  const tail = { choices: [{ delta: { content: '{"file_path":"a.ts"}}</tool_call>' }, index: 0 }] };

  it('openai: вызов из хвоста собран, причина «вызов» — после него и до [DONE]', () => {
    const t = translator({ shim: { allowed: new Set(['Write']) } });
    const out = t.push(sse(head, tail, '[DONE]')) + t.end();
    expect(t.facts.toolCalls).toBe(1);
    expect(out).toContain('a.ts');
    const call = out.indexOf('"tool_calls":[');
    const finish = out.indexOf('"finish_reason":"tool_calls"');
    expect(call).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(call);
    expect(out.indexOf('[DONE]')).toBeGreaterThan(finish);
    // Причина остановки уходит ОДИН раз: вторая, «stop», закрыла бы ход раньше вызова.
    expect(out).not.toContain('"finish_reason":"stop"');
  });

  it('anthropic: блок tool_use из хвоста и stop_reason tool_use', () => {
    const t = translator({ dialect: 'anthropic', shim: { allowed: new Set(['Write']) } });
    const out = t.push(sse(head, tail, '[DONE]')) + t.end();
    expect(t.facts.toolCalls).toBe(1);
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });
});

describe('итоговый текст платформы (enterprise-platform_deanonymized)', () => {
  it('дописывает недоставленный хвост, если поток — его начало', () => {
    const t = translator();
    const out =
      t.push(
        sse(text('Адрес: ', 'stop'), { enterprise-platform_deanonymized: 'Адрес: ivan@corp.ru' }, '[DONE]'),
      ) + t.end();
    expect(out).toContain('ivan@corp.ru');
    expect(out.indexOf('ivan@corp.ru')).toBeLessThan(out.indexOf('[DONE]'));
    expect(out).not.toContain('enterprise-platform_');
    expect(t.assembled().text).toBe('Адрес: ivan@corp.ru');
    expect(t.facts.rewritten).toBeUndefined();
  });

  it('совпавший с потоком текст не дублируется', () => {
    const t = translator({ dialect: 'anthropic' });
    const out =
      t.push(sse(text('Готово.', 'stop'), { enterprise-platform_deanonymized: 'Готово.' }, '[DONE]')) + t.end();
    expect(out.split('Готово.').length).toBe(2);
    expect(t.facts.rewritten).toBeUndefined();
  });

  it('разошедшийся текст назван фактом, а цельное тело несёт итоговый', () => {
    const t = translator();
    t.push(
      sse(
        text('Телефон 89001234567', 'stop'),
        { enterprise-platform_deanonymized: 'Телефон [PHONE]' },
        '[DONE]',
      ),
    );
    t.end();
    expect(t.facts.rewritten).toBe('diverged');
    expect(t.assembled().text).toBe('Телефон [PHONE]');
  });

  it('разошедшийся текст с вызовом внутри собирается вызовом в цельном теле', () => {
    const t = translator({ shim: { allowed: new Set(['Write']) } });
    t.push(
      sse(
        text('черновик', 'stop'),
        {
          enterprise-platform_deanonymized:
            'итог <tool_call>{"name":"Write","arguments":{"file_path":"b.ts"}}</tool_call>',
        },
        '[DONE]',
      ),
    );
    t.end();
    const answer = t.assembled();
    expect(answer.calls.map((call) => call.arguments)).toEqual([{ file_path: 'b.ts' }]);
    expect(answer.text).toBe('итог ');
    expect(answer.finishReason).toBe('tool_calls');
  });
});

describe('карта подмены контура списком', () => {
  it('[{placeholder, value}] разворачивается в аргументах вызова', () => {
    const t = translator({ shim: { allowed: new Set(['Write']) } });
    const out =
      t.push(
        sse(
          { enterprise-platform_deanonymized_entities: [{ placeholder: '[EMAIL_1]', value: 'ivan@corp.ru' }] },
          text(
            '<tool_call>{"name":"Write","arguments":{"content":"[EMAIL_1]"}}</tool_call>',
            'stop',
          ),
          '[DONE]',
        ),
      ) + t.end();
    expect(out).toContain('ivan@corp.ru');
    expect(t.facts.maskStop).toEqual([]);
    expect(t.facts.masked).toBe(true);
  });
});

describe('метка платформы, которую никто не развернул', () => {
  const call = text(
    '<tool_call>{"name":"Write","arguments":{"content":"звонить [PHONE_1]"}}</tool_call>',
    'stop',
  );
  const sanitized = { enterprise-platform_sanitized: true, violations: [{ rule_name: 'pii' }] };

  function run(sent: string, frames: unknown[]): StreamTranslator {
    const t = translator({
      shim: { allowed: new Set(['Write']) },
      placeholders: { pattern: enterprise-platformDriver.placeholderPattern as RegExp, sent },
    });
    t.push(sse(...frames, '[DONE]'));
    t.end();
    return t;
  }

  it('останавливает вызов, когда платформа сказала, что подменяла', () => {
    const t = run('{"messages":[{"content":"позвони"}]}', [sanitized, call]);
    expect(t.facts.maskStop).toEqual(['[PHONE_1]']);
  });

  it('пропускает, если та же строка была в запросе — это текст человека', () => {
    const t = run('{"messages":[{"content":"шаблон звонить [PHONE_1]"}]}', [sanitized, call]);
    expect(t.facts.maskStop).toEqual([]);
    expect(t.facts.toolCalls).toBe(1);
  });

  it('пропускает, если платформа ни о какой подмене не говорила', () => {
    const t = run('{"messages":[{"content":"позвони"}]}', [call]);
    expect(t.facts.maskStop).toEqual([]);
  });
});

describe('поддержание связи', () => {
  it('комментарий контура становится ping клиенту Anthropic', () => {
    const t = translator({ dialect: 'anthropic' });
    expect(t.push(': keepalive\n\n')).toContain('event: ping');
  });

  it('клиенту OpenAI уходит комментарий, а не кадр данных', () => {
    const t = translator();
    const out = t.push(': OPENROUTER PROCESSING\n\n');
    expect(out.startsWith(':')).toBe(true);
    expect(out).not.toContain('data:');
  });
});
