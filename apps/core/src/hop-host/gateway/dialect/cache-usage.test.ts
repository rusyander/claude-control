import { describe, it, expect } from 'vitest';
import { anthropicUsage, cacheTokensOf, openAiUsage } from './cache-usage.ts';

/** Расход с кэшем (n4b): числа — живой замер 22.10.2026, haiku через платформу компании. */

describe('кэш из расхода', () => {
  it('поля LiteLLM: запись верхним полем и часовая разбивка', () => {
    expect(
      cacheTokensOf({
        prompt_tokens: 9728,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 9712,
          cache_creation_token_details: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 9712,
          },
        },
        cache_creation_input_tokens: 9712,
      }),
    ).toEqual({ read: 0, write: 9712, write1h: 9712 });
  });

  it('только `cache_write_tokens` — запись берётся из него', () => {
    expect(
      cacheTokensOf({ prompt_tokens_details: { cache_write_tokens: 50, cached_tokens: 10 } }),
    ).toEqual({ read: 10, write: 50, write1h: 0 });
  });

  it('OpenAI и vLLM: только прочитанное', () => {
    expect(cacheTokensOf({ prompt_tokens_details: { cached_tokens: 5632 } })).toEqual({
      read: 5632,
      write: 0,
      write1h: 0,
    });
    expect(cacheTokensOf(undefined)).toEqual({ read: 0, write: 0, write1h: 0 });
  });
});

describe('расход в форме Anthropic', () => {
  it('вход без прочитанного и записанного; запись — числом и разбивкой', () => {
    expect(anthropicUsage(9728, 4, { read: 0, write: 9712, write1h: 9712 })).toEqual({
      input_tokens: 16,
      cache_creation_input_tokens: 9712,
      output_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9712 },
    });
  });

  it('прежняя форма числом: только прочитанное', () => {
    expect(anthropicUsage(1000, 5, 800)).toEqual({
      input_tokens: 200,
      cache_read_input_tokens: 800,
      output_tokens: 5,
    });
  });

  it('кэш больше входа не уводит вход в минус', () => {
    expect(anthropicUsage(100, 1, { read: 80, write: 50, write1h: 50 })).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 80,
      output_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 },
    });
  });
});

describe('расход в форме OpenAI', () => {
  it('без записи — как раньше', () => {
    expect(openAiUsage(1000, 5, 1005, 800)).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 5,
      total_tokens: 1005,
      prompt_tokens_details: { cached_tokens: 800 },
    });
  });

  it('запись — полями LiteLLM, и мост читает её обратно', () => {
    const usage = openAiUsage(9728, 4, 9732, { read: 0, write: 9712, write1h: 9712 });
    expect(cacheTokensOf(usage)).toEqual({ read: 0, write: 9712, write1h: 9712 });
  });
});
