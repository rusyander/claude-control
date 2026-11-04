import { describe, it, expect } from 'vitest';
import { ThinkSplitter, withoutThink } from './think-tail.ts';

/**
 * Размышления, приехавшие текстом ответа (L9). Форма взята из живой пробы dev
 * 14.09.2026: Qwen3.8 за vLLM пишет рассуждение в `content` и закрывает его
 * голым `</think>`, а чанки режут тег где придётся.
 *
 * У панели разборщик остался ради `withoutThink` (ответ пробного запроса активации). Размышления в
 * потоке шлюза — у ядра (этап 10, C3d): `apps/core/src/hop-host/gateway/think-tail/think-tail.test.ts`,
 * describe «размышления текстом в потоке шлюза».
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
