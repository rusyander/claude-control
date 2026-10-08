import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FULL_READ_LIMIT, readAllRecords, readRecords } from './ChatTranscriptFile.ts';

/**
 * Чтение транскрипта целиком кусками (Ф15): ни одна строка не теряется на
 * границе куска, в том числе когда граница режет многобайтный символ.
 */
describe('readAllRecords', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-transcript-all-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('файл больше FULL_READ_LIMIT — каждая строка на месте, по порядку', () => {
    const lines: string[] = [];
    let size = 0;
    for (let index = 0; size < FULL_READ_LIMIT + 2 * 1024 * 1024; index += 1) {
      // Нечётная длина «ж»-хвоста сдвигает границы кусков по середине символа.
      const text = `${index} ${'ж'.repeat(1000 + (index % 7))}`;
      const line = JSON.stringify({
        type: 'user',
        uuid: String(index),
        message: { content: text },
      });
      lines.push(line);
      size += Buffer.byteLength(line) + 1;
    }
    const file = join(dir, 'big.jsonl');
    // Последняя строка — без перевода строки в конце, как у оборванного файла.
    writeFileSync(file, lines.join('\n'));

    const records = readAllRecords(file);
    expect(records).toHaveLength(lines.length);
    expect(records.map((record) => record.uuid)).toEqual(lines.map((_, index) => String(index)));
    // Чтение для ленты у того же файла теряет середину — потому и нужен этот путь.
    expect(readRecords(file, 0).length).toBeLessThan(lines.length);
  });
});
