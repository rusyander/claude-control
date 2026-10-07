import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGeminiStreamParser } from './gemini-stream.ts';

/**
 * Поток `gemini -o stream-json` снят живым прогоном gemini 0.62.0 на заглушке
 * модели: ход «вызов write_file → итог», после которого CLI на win32 упал на
 * выходе с кодом 0xC0000409, напечатав всё до события `result`.
 */
const fixture = readFileSync(
  new URL('./__fixtures__/gemini-0.62-stream-json.jsonl', import.meta.url),
  'utf8',
);

const run = (chunks: string[]) => {
  const parser = createGeminiStreamParser();
  const text = chunks.map((chunk) => parser.push(chunk)).join('') + parser.end();
  return { text, settled: parser.settled?.() };
};

describe('gemini stream-json', () => {
  it('ответ — только текст ассистента; init, запрос и инструмент ответом не становятся', () => {
    const { text, settled } = run([fixture]);
    expect(text).toBe('AFTER_TOOL');
    expect(settled).toBe(true);
  });

  it('поток, порезанный посреди строки, собирается так же', () => {
    const cuts = fixture.match(/[\s\S]{1,37}/g) ?? [];
    expect(run(cuts)).toEqual(run([fixture]));
  });

  it('куски ответа склеиваются, текст после инструмента — с пустой строки', () => {
    const lines = [
      { type: 'message', role: 'assistant', content: 'Пишу ', delta: true },
      { type: 'message', role: 'assistant', content: 'файл.', delta: true },
      { type: 'tool_use', tool_name: 'write_file' },
      { type: 'tool_result', status: 'success' },
      { type: 'message', role: 'assistant', content: 'Готово.', delta: true },
    ].map((event) => `${JSON.stringify(event)}\n`);
    expect(run(lines).text).toBe('Пишу файл.\n\nГотово.');
  });

  it('без `result: success` ход не считается удавшимся — решает код выхода', () => {
    const cut = fixture.split('\n').filter((line) => !line.includes('"type":"result"'));
    expect(run([cut.join('\n')]).settled).toBe(false);
    const failed = `${JSON.stringify({ type: 'result', status: 'error' })}\n`;
    expect(run([failed]).settled).toBe(false);
  });

  it('строка не JSON (предупреждение CLI) пропускается', () => {
    expect(run(['YOLO mode is enabled.\n', fixture]).text).toBe('AFTER_TOOL');
  });
});
