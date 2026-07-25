import { describe, it, expect } from 'vitest';
import { createZip, readZip, crc32 } from './zip.ts';

/**
 * Свой ZIP пишет файлы, которые пользователь унесёт на другую машину и откроет
 * штатным распаковщиком, поэтому проверяем не «наш код читает наш вывод», а
 * структуру формата: сигнатуры, размеры, контрольные суммы. Отдельно —
 * fail-closed: битый архив должен падать здесь, а не после записи на диск.
 */
describe('zip: сборка и разбор', () => {
  const stamp = new Date('2026-07-25T12:34:56Z');

  it('текст и двоичные данные переживают круг без потерь', () => {
    const binary = Buffer.from([0, 1, 2, 253, 254, 255, 0, 0, 42]);
    const zip = createZip(
      [
        { path: 'MANIFEST.json', data: Buffer.from('{"kind":"тест"}', 'utf8') },
        { path: 'files/loc-0/skills/иконка.png', data: binary },
      ],
      stamp,
    );

    const entries = readZip(zip);
    expect(entries.map((entry) => entry.path)).toEqual([
      'MANIFEST.json',
      'files/loc-0/skills/иконка.png',
    ]);
    expect(entries[0]!.data.toString('utf8')).toBe('{"kind":"тест"}');
    expect(entries[1]!.data.equals(binary)).toBe(true);
  });

  it('это настоящий ZIP: сигнатуры записей и опись в конце', () => {
    const zip = createZip([{ path: 'a.txt', data: Buffer.from('a') }], stamp);

    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // локальный заголовок
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50); // конец каталога
    expect(zip.readUInt16LE(zip.length - 12)).toBe(1); // записей в каталоге
    // Флаг UTF-8 обязателен: без него кириллица в путях читается мусором.
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it('одинаковый вход и одна дата дают побайтово одинаковый архив', () => {
    const entries = [{ path: 'a.txt', data: Buffer.from('одно и то же') }];
    expect(createZip(entries, stamp).equals(createZip(entries, stamp))).toBe(true);
  });

  it('несжимаемые данные кладутся как есть и архив от этого не растёт', () => {
    // Псевдослучайные байты deflate только раздувает — запись уйдёт методом store.
    // Генератор детерминированный, чтобы тест не зависел от случая.
    const noise = Buffer.alloc(4096);
    let state = 0x2545f491;
    for (let index = 0; index < noise.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noise[index] = state & 0xff;
    }
    const zip = createZip([{ path: 'noise.bin', data: noise }], stamp);

    expect(zip.readUInt16LE(8)).toBe(0); // метод 0 = store
    expect(readZip(zip)[0]!.data.equals(noise)).toBe(true);
  });

  it('битое содержимое не проходит проверку целостности', () => {
    const zip = createZip(
      [{ path: 'a.txt', data: Buffer.from('текст подлиннее для сжатия') }],
      stamp,
    );
    const damaged = Buffer.from(zip);
    damaged[40] = damaged[40]! ^ 0xff;

    expect(() => readZip(damaged)).toThrow();
  });

  it('чужой файл не выдаётся за архив', () => {
    expect(() => readZip(Buffer.from('это просто текст'))).toThrow(/не ZIP|каталог/i);
  });

  it('имя записи не может выводить за пределы архива', () => {
    expect(() => createZip([{ path: '../../etc/passwd', data: Buffer.from('x') }], stamp)).toThrow(
      /за его пределы/,
    );
    expect(() => createZip([{ path: '', data: Buffer.from('x') }], stamp)).toThrow(/Недопустимое/);
  });

  it('CRC-32 совпадает с эталонным значением', () => {
    // Классический вектор: CRC-32("123456789") = 0xCBF43926.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
