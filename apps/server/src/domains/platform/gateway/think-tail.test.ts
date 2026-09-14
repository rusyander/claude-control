import { describe, it, expect } from 'vitest';
import { enterprise-platformDriver } from '../drivers/enterprise-platform.ts';
import { StreamTranslator } from './frames.ts';
import { ThinkSplitter, withoutThink } from './think-tail.ts';

/**
 * Размышления, приехавшие текстом ответа (L9). Форма взята из живой пробы dev
 * 14.09.2026: Qwen3.8 за vLLM пишет рассуждение в `content` и закрывает его
 * голым `</think>`, а чанки режут тег где придётся.
 */

function feed(splitter: ThinkSplitter, chunks: string[]): string {
  return chunks.map((chunk) => splitter.push(chunk)).join('') + splitter.end();
}

describe('ThinkSplitter', () => {
  it('lead: ответ, начатый с <think>, теряет размышление даже при тегах, разрезанных чанками', () => {
    const splitter = new ThinkSplitter('lead');
    const out = feed(splitter, ['<thi', 'nk>пл', 'ан</thi', 'nk>\n', '\nГотово']);
    expect(out).toBe('Готово');
    expect(splitter.reasoningChars).toBe(4);
    expect(splitter.sawBareClose).toBe(false);
  });

  it('lead: обычный ответ уходит сразу, а голый </think> в нём — факт для следующих', () => {
    const splitter = new ThinkSplitter('lead');
    expect(splitter.push('раздумье</th')).toBe('раздумье</th');
    expect(splitter.push('ink>\n\nответ')).toBe('ink>\n\nответ');
    expect(splitter.sawBareClose).toBe(true);
    expect(splitter.reasoningChars).toBe(0);
  });

  it('lead: скобка, не ставшая тегом, держится только до ясности', () => {
    const splitter = new ThinkSplitter('lead');
    expect(splitter.push('<th')).toBe('');
    expect(splitter.push('e>')).toBe('<the>');
    expect(splitter.end()).toBe('');
  });

  it('tail: всё до голого </think> снимается, пробелы перед ответом тоже', () => {
    const splitter = new ThinkSplitter('tail');
    expect(splitter.push('Нужно вызвать Write')).toBe('');
    expect(splitter.push('</think>')).toBe('');
    expect(splitter.push('\n\n')).toBe('');
    expect(splitter.push('Файл создан')).toBe('Файл создан');
    expect(splitter.reasoningChars).toBe('Нужно вызвать Write'.length);
    expect(splitter.sawBareClose).toBe(false);
  });

  it('tail: тег так и не пришёл — придержанное отдаётся текстом, а не теряется', () => {
    const splitter = new ThinkSplitter('tail');
    expect(splitter.push('Короткий ответ без размышлений')).toBe('');
    expect(splitter.end()).toBe('Короткий ответ без размышлений');
    expect(splitter.reasoningChars).toBe(0);
  });

  it('withoutThink снимает размышление с цельного текста и не трогает текст без него', () => {
    expect(withoutThink('думаю</think>\n\nответ')).toBe('ответ');
    expect(withoutThink('<think>думаю</think>ответ')).toBe('ответ');
    expect(withoutThink('просто ответ')).toBe('просто ответ');
  });
});

function sse(...frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join('');
}

const chunk = (content: string, finish: string | null = null): string =>
  JSON.stringify({
    id: 'c1',
    model: 'qwen',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });

/** Все куски текста, ушедшие клиенту в диалекте OpenAI, — подряд. */
function openAiText(out: string): string {
  return out
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const payload = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string } }[];
      };
      return payload.choices?.[0]?.delta?.content ?? '';
    })
    .join('');
}

describe('размышления текстом в потоке шлюза', () => {
  it('OpenAI: клиент получает только ответ, след — стадию размышления', () => {
    const translator = new StreamTranslator({
      driver: enterprise-platformDriver,
      dialect: 'openai-compat',
      model: 'qwen',
      includeUsage: false,
      think: 'tail',
    });
    const out =
      translator.push(
        sse(
          chunk('Пользователь просит'),
          chunk(' файл</th'),
          chunk('ink>\n\nГо'),
          chunk('тово', 'stop'),
        ),
      ) + translator.push(sse('[DONE]'));
    expect(openAiText(out)).toBe('Готово');
    expect(out).not.toContain('think');
    expect(translator.facts.reasoningChars).toBeGreaterThan(0);
    expect(translator.facts.stages).toContain('reasoning');
    expect(translator.assembled().text).toBe('Готово');
  });

  it('Anthropic с прослойкой: вызов, прикинутый в размышлении, не выполняется', () => {
    const translator = new StreamTranslator({
      driver: enterprise-platformDriver,
      dialect: 'anthropic',
      model: 'qwen',
      includeUsage: false,
      think: 'tail',
      shim: { allowed: new Set(['Write']) },
    });
    const draft = '{"name":"Write","arguments":{"file_path":"a.ts","content":"x"}}';
    const out = translator.push(
      sse(chunk(draft), chunk('</think>\n\n'), chunk('Сначала уточню путь.', 'stop'), '[DONE]'),
    );
    expect(out).not.toContain('tool_use');
    expect(out).toContain('Сначала уточню путь.');
    expect(out).not.toContain('file_path');
    expect(translator.facts.toolCalls).toBe(0);
  });

  it('незакрытое размышление уходит текстом раньше [DONE]', () => {
    const translator = new StreamTranslator({
      driver: enterprise-platformDriver,
      dialect: 'openai-compat',
      model: 'qwen',
      includeUsage: false,
      think: 'tail',
    });
    const out = translator.push(sse(chunk('Просто ответ', 'stop'), '[DONE]'));
    expect(openAiText(out)).toBe('Просто ответ');
    expect(out.indexOf('Просто ответ')).toBeLessThan(out.indexOf('[DONE]'));
  });

  it('обрыв потока отдаёт придержанное текстом до ошибки', () => {
    const translator = new StreamTranslator({
      driver: enterprise-platformDriver,
      dialect: 'openai-compat',
      model: 'qwen',
      includeUsage: false,
      think: 'tail',
    });
    const out = translator.push(sse(chunk('Половина ответа'))) + translator.end();
    expect(openAiText(out)).toBe('Половина ответа');
    expect(translator.facts.truncated).toBe(true);
  });

  it('lead без тега ничего не держит, а голый </think> ставит факт', () => {
    const translator = new StreamTranslator({
      driver: enterprise-platformDriver,
      dialect: 'openai-compat',
      model: 'qwen',
      includeUsage: false,
    });
    const first = translator.push(sse(chunk('размышление</think>')));
    expect(openAiText(first)).toBe('размышление</think>');
    translator.push(sse(chunk('ответ', 'stop'), '[DONE]'));
    expect(translator.facts.bareThinkClose).toBe(true);
    expect(translator.facts.reasoningChars).toBe(0);
  });
});
