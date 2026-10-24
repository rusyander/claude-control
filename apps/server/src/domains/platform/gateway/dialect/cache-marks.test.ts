import { describe, it, expect } from 'vitest';
import { anthropicRequestToOpenAi, forwardsCacheMarks } from './dialect.ts';
import { cacheMarkOf } from './cache-marks.ts';
import { enterprisePlatformDriver } from '../../drivers/enterprise-platform.ts';
import { openAiCompatDriver } from '../../drivers/openai-compat.ts';

/** Пометки кэша на мосту Anthropic → OpenAI (n4a): правила, которые не видны из конвейера. */

const MARK = { type: 'ephemeral' } as const;
const fields = enterprisePlatformDriver.requestFields;

type Part = { type: string; text?: string; cache_control?: unknown };

function messagesOf(body: Record<string, unknown>): { role: string; content: unknown }[] {
  return body.messages as { role: string; content: unknown }[];
}

describe('кому пометки', () => {
  it('платформа компании: семейство claude — да, gpt и vLLM — нет', () => {
    expect(forwardsCacheMarks(enterprisePlatformDriver, 'claude-haiku-5-5')).toBe(true);
    expect(forwardsCacheMarks(enterprisePlatformDriver, 'Claude-Fable-5')).toBe(true);
    expect(forwardsCacheMarks(enterprisePlatformDriver, 'gpt-4.1-mini')).toBe(false);
    expect(forwardsCacheMarks(enterprisePlatformDriver, 'Qwen/Qwen3.8-27B-FP8')).toBe(false);
    expect(forwardsCacheMarks(enterprisePlatformDriver, undefined)).toBe(false);
  });

  it('драйвер без объявления — никому', () => {
    expect(forwardsCacheMarks(openAiCompatDriver, 'claude-haiku-5-5')).toBe(false);
  });

  it('пометка очищается до типа и срока; не та форма — пометки нет', () => {
    expect(cacheMarkOf({ type: 'ephemeral', ttl: '1h', scope: 'global' })).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(cacheMarkOf({ type: 'ephemeral', ttl: '7d' })).toEqual({ type: 'ephemeral' });
    expect(cacheMarkOf({ type: 'persistent' })).toBeUndefined();
    expect(cacheMarkOf('ephemeral')).toBeUndefined();
  });
});

describe('куда пометка', () => {
  it('реплика из нескольких частей остаётся частями и без пометки — префикс не меняет форму между ходами', () => {
    const turn = (marked: boolean) =>
      anthropicRequestToOpenAi(
        {
          model: 'claude-haiku-5-5',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'раз' },
                { type: 'text', text: 'два', ...(marked ? { cache_control: MARK } : {}) },
              ],
            },
          ],
        },
        fields,
        undefined,
        true,
      );
    const marked = messagesOf(turn(true).body)[0]!.content as Part[];
    const plain = messagesOf(turn(false).body)[0]!.content as Part[];
    expect(marked.map((part) => part.text)).toEqual(['раз', 'два']);
    expect(plain.map((part) => part.text)).toEqual(['раз', 'два']);
    expect(marked[1]!.cache_control).toEqual(MARK);
    expect(plain[1]!.cache_control).toBeUndefined();
  });

  it('одна часть без пометки — строкой, с пометкой — частью', () => {
    const { body } = anthropicRequestToOpenAi(
      {
        model: 'claude-haiku-5-5',
        messages: [
          { role: 'user', content: 'старое' },
          { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] },
          { role: 'user', content: [{ type: 'text', text: 'новое', cache_control: MARK }] },
        ],
      },
      fields,
      undefined,
      true,
    );
    const messages = messagesOf(body);
    expect(messages[0]!.content).toBe('старое');
    expect(messages[1]!.content).toBe('ответ');
    expect(messages[2]!.content).toEqual([{ type: 'text', text: 'новое', cache_control: MARK }]);
  });

  it('блок без части отдаёт пометку части перед собой; некуда — потеря названа', () => {
    const { body, lost } = anthropicRequestToOpenAi(
      {
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'вопрос' },
              { type: 'document', source: {}, cache_control: MARK },
            ],
          },
          { role: 'user', content: [{ type: 'thinking', thinking: 'x', cache_control: MARK }] },
        ],
      },
      fields,
      undefined,
      true,
    );
    expect(messagesOf(body)[0]!.content).toEqual([
      { type: 'text', text: 'вопрос', cache_control: MARK },
    ]);
    expect(lost.map((item) => item.field)).toContain('cache_control');
  });

  it('без пометок путь прежний: система склеена строкой, потеря названа', () => {
    const { body, lost } = anthropicRequestToOpenAi(
      {
        model: 'claude-haiku-5-5',
        system: [
          { type: 'text', text: 'а' },
          { type: 'text', text: 'б', cache_control: MARK },
        ],
        messages: [{ role: 'user', content: 'в' }],
      },
      fields,
    );
    expect(messagesOf(body)[0]).toEqual({ role: 'system', content: 'а\n\nб' });
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(lost.map((item) => item.field)).toEqual(
      expect.arrayContaining(['cache_control', 'system[] (массив блоков)']),
    );
  });
});
