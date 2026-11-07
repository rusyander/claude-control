import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { OUTPUT_TAIL_BYTES, outputSize, readOutputTail } from './output-tail.ts';

/** Работа кончилась: последняя строка файла больше не допишется. */
const ENDED = true;

/**
 * Хвост файла вывода фоновой работы (этап 11, P148) по настоящему файлу: чтение ограничено
 * пределом, обрезанный посреди символ UTF-8 срезается, пропавший файл — причина, а не пустой хвост.
 */

describe('stage 11 background output tail (platform)', () => {
  it('reads only the last bytes of a big file, marks it truncated and keeps its true size', () => {
    const file = join(tempDir('out-tail-'), 'bash_1.output');
    const line = `${'a'.repeat(100)}\n`;
    const body = `${line.repeat(2_000)}THE-END`;
    writeFileSync(file, body);
    // Работа кончилась (`ended`): последняя строка без перевода строки — целая, отдаётся.
    const tail = readOutputTail(file, OUTPUT_TAIL_BYTES, ENDED);
    if (!('text' in tail)) throw new Error(tail.missing);
    // Предел — потолок; начало — с целой строки (обломок первой отброшен).
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(tail.text)).toBeGreaterThan(OUTPUT_TAIL_BYTES - line.length);
    expect(tail.text.startsWith(line)).toBe(true);
    expect(tail.text.endsWith('THE-END')).toBe(true);
    expect(tail).toMatchObject({ truncated: true, size: body.length });
    expect(outputSize(file)).toBe(body.length);
    const small = readOutputTail(file, 10, ENDED);
    expect(small).toMatchObject({ text: 'THE-END', truncated: true });
  });

  it('a cut through a multi-byte character never shows its continuation bytes; a short file is whole', () => {
    const file = join(tempDir('out-tail-'), 'utf8.output');
    writeFileSync(file, 'начало хвост');
    // « хвост» = 11 байт; 12-й с конца — второй байт «о» (байт продолжения): окно начнётся со слова.
    const cut = readOutputTail(file, 12, ENDED);
    if (!('text' in cut)) throw new Error(cut.missing);
    expect(cut.text).toBe('хвост');
    expect(cut.text.includes('�')).toBe(false);
    expect(readOutputTail(file, OUTPUT_TAIL_BYTES, ENDED)).toMatchObject({
      text: 'начало хвост',
      truncated: false,
    });
  });

  it('a cut window starts at a whole line, else a whole word: the fragment the cut split is not served', () => {
    const file = join(tempDir('out-tail-'), 'lines.output');
    const pw = 'DB_PASSWORD=hunter2Secret!Pass\n';
    writeFileSync(file, `${'x'.repeat(50)}\n${pw}next line\n`);
    // Окно режет строку пароля посреди («D=hunter2Secret!Pass…»): без «DB_PASSWORD=» маска
    // обломок не узнала бы — строка отброшена целиком.
    expect(readOutputTail(file, 'D=hunter2Secret!Pass\nnext line\n'.length)).toMatchObject({
      text: 'next line\n',
      truncated: true,
    });
    // Окно ровно с начала строки — строка целая.
    const whole = readOutputTail(file, `${pw}next line\n`.length);
    expect('text' in whole && whole.text).toBe(`${pw}next line\n`);
    const one = join(tempDir('out-tail-'), 'one-line.output');
    writeFileSync(one, 'Authorization: Bearer abcdef0123456789 done');
    expect(readOutputTail(one, '456789 done'.length, ENDED)).toMatchObject({ text: 'done' });
    expect(readOutputTail(one, 'done'.length, ENDED)).toMatchObject({ text: 'done' });
    expect(readOutputTail(one, 3, ENDED)).toMatchObject({ text: '', truncated: true });
  });

  it('a line still being written is held back until its newline: a secret written in two chunks is never served as a prefix', () => {
    const file = join(tempDir('out-tail-'), 'live.output');
    const key = ['Authorization: Bearer ', 'abcdef0123', '456789XYZ'];
    // Первый кусок: строка ключа оборвана посреди — маска узнала бы только её префикс.
    writeFileSync(file, `ready\n${key[0]}${key[1]}`);
    expect(readOutputTail(file)).toMatchObject({ text: 'ready\n', truncated: false });
    // Второй кусок дописал строку — она отдаётся целой.
    appendFileSync(file, `${key[2]}\n`);
    expect(readOutputTail(file)).toMatchObject({ text: `ready\n${key.join('')}\n` });
    // Одна недописанная строка длиннее окна — не отдаётся ничего.
    const one = join(tempDir('out-tail-'), 'one-live.output');
    writeFileSync(one, `${key[0]}${'z'.repeat(64)}`);
    expect(readOutputTail(one, 32)).toMatchObject({ text: '', truncated: true });
    // Работа кончилась: последняя строка больше не допишется — отдаётся целой.
    writeFileSync(file, 'ready\nexit 0');
    expect(readOutputTail(file, OUTPUT_TAIL_BYTES, ENDED)).toMatchObject({
      text: 'ready\nexit 0',
    });
  });

  it('a path that is not a regular file is refused with a reason, and its size is unknown', () => {
    const dir = tempDir('out-tail-dir-');
    const tail = readOutputTail(dir);
    expect('missing' in tail && tail.missing).toContain('not a regular file');
    // Каталог «без роста» — не повод для bg-hang: размера у него нет.
    expect(outputSize(dir)).toBeNull();
  });

  // FIFO есть только на POSIX: открыть его на чтение без писателя — вечная блокировка потока ядра.
  // Чтение — в дочернем процессе со сроком: зависание видно как убитый по сроку ребёнок.
  it.runIf(process.platform !== 'win32')(
    'a FIFO output path never blocks the read: refused at once with a reason',
    async () => {
      const fifo = join(tempDir('out-tail-fifo-'), 'bash_1.output');
      execFileSync('mkfifo', [fifo]);
      const mod = new URL('./output-tail.ts', import.meta.url).href;
      const code = `const m = await import(${JSON.stringify(mod)}); console.log(JSON.stringify([m.readOutputTail(${JSON.stringify(fifo)}), m.outputSize(${JSON.stringify(fifo)})]));`;
      const out = await new Promise<{ killed: boolean; stdout: string }>((done) => {
        execFile(
          process.execPath,
          ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code],
          { timeout: 5_000 },
          (error, stdout) => done({ killed: Boolean(error?.killed), stdout }),
        );
      });
      expect(out.killed).toBe(false);
      const [tail, size] = JSON.parse(out.stdout) as [{ missing?: string }, number | null];
      expect(tail.missing).toContain('not a regular file');
      expect(size).toBeNull();
    },
    20_000,
  );

  it('a missing file names why, and its size is unknown', () => {
    const file = join(tempDir('out-tail-'), 'gone.output');
    const tail = readOutputTail(file);
    expect('missing' in tail && tail.missing).toContain('ENOENT');
    expect(outputSize(file)).toBeNull();
  });
});
