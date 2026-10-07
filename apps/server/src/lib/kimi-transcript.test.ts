import { describe, expect, it } from 'vitest';
import { kimiTranscriptParser } from './kimi-transcript.ts';

/** Прогнать вывод через разборщик кусками заданного размера — как его режет труба. */
function parse(stdout: string, size = stdout.length || 1): string {
  const parser = kimiTranscriptParser();
  let out = '';
  for (let i = 0; i < stdout.length; i += size) out += parser.push(stdout.slice(i, i + size));
  return out + parser.end();
}

// Сняты с настоящего `kimi -p` 2.1.1 на заглушке модели (06.10.2026), байт в байт.
const SINGLE = '• STUB_REPLY_OK\n\n';
const MULTILINE = '• AAAA word word \n  line2\n      indented code\n\n  - item\n\n';
const TWO_MESSAGES = '• Let me write.\n    keep indent\n\n• Done.\n  second\n\n';

describe('kimiTranscriptParser: стенограмма `kimi -p` → текст ответа', () => {
  it('одно сообщение: маркер и хвостовая пустая строка сняты', () => {
    expect(parse(SINGLE)).toBe('STUB_REPLY_OK');
  });

  it('многострочное: отступ снят, свой отступ кода и пустая строка внутри целы', () => {
    expect(parse(MULTILINE)).toBe('AAAA word word \nline2\n    indented code\n\n- item');
  });

  it('два сообщения (до и после инструмента) — через пустую строку, как у живого хода', () => {
    expect(parse(TWO_MESSAGES)).toBe('Let me write.\n  keep indent\n\nDone.\nsecond');
  });

  it('куски любой длины дают тот же ответ — граница чтения рвёт строку где угодно', () => {
    for (const size of [1, 2, 3, 5, 7]) {
      expect(parse(TWO_MESSAGES, size)).toBe('Let me write.\n  keep indent\n\nDone.\nsecond');
      expect(parse(MULTILINE, size)).toBe('AAAA word word \nline2\n    indented code\n\n- item');
    }
  });

  it('текст, начинающийся с маркера, теряет только оформление', () => {
    expect(parse('• • пункт\n  • ещё\n\n')).toBe('• пункт\n• ещё');
  });

  it('CRLF не оставляет \\r в ответе', () => {
    expect(parse('• a\r\n  b\r\n\r\n')).toBe('a\nb');
  });

  it('строка не по форме не теряется', () => {
    expect(parse('неожиданно\n• ответ\n')).toBe('неожиданно\n\nответ');
    expect(parse('• ответ\nбез отступа\n')).toBe('ответ\nбез отступа');
  });

  it('хвост без перевода строки отдаётся на end()', () => {
    const parser = kimiTranscriptParser();
    expect(parser.push('• ответ')).toBe('');
    expect(parser.end()).toBe('ответ');
  });

  it('пустой вывод — пустой ответ', () => {
    expect(parse('')).toBe('');
    expect(parse('\n\n')).toBe('');
  });
});
