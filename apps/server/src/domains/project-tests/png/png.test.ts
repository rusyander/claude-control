import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PngFormatError, decodePng, encodePng, type PngImage } from './png.ts';

/**
 * Свой разбор PNG. Проверяется то, ради чего он написан вместо зависимости:
 * файл из настоящего скриншотера приходит со ВСЕМИ фильтрами строк вперемешку,
 * и ошибка в любом из них даёт не исключение, а тихо съехавшие пиксели — то
 * есть ложную разницу в сравнении эталонов.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Предсказатель Paeth — считаем в тесте отдельно, а не берём из кода. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Собрать PNG из готовых строк, наложив ПРЯМЫЕ фильтры. Обратную операцию и
 * проверяем: формулы здесь написаны отдельно от разбора, поэтому совпадение
 * значит совпадение, а не общую ошибку.
 */
function buildPng(
  width: number,
  height: number,
  channels: number,
  colorType: number,
  rows: number[][],
  filters: number[],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(colorType, 9);

  const rowBytes = width * channels;
  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y] ?? 0;
    raw.push(filter);
    for (let index = 0; index < rowBytes; index += 1) {
      const value = rows[y]![index]!;
      const left = index >= channels ? rows[y]![index - channels]! : 0;
      const up = y > 0 ? rows[y - 1]![index]! : 0;
      const corner = y > 0 && index >= channels ? rows[y - 1]![index - channels]! : 0;
      const encoded =
        filter === 0
          ? value
          : filter === 1
            ? value - left
            : filter === 2
              ? value - up
              : filter === 3
                ? value - ((left + up) >> 1)
                : value - paeth(left, up, corner);
      raw.push(encoded & 0xff);
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pixel(image: PngImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.data.slice(at, at + 4)];
}

describe('png', () => {
  it('разбирает RGB со всеми фильтрами строк', () => {
    const rows = [
      [10, 20, 30, 200, 100, 50, 5, 5, 5],
      [11, 21, 31, 201, 101, 51, 6, 6, 6],
      [12, 22, 32, 202, 102, 52, 7, 7, 7],
      [13, 23, 33, 203, 103, 53, 8, 8, 8],
      [14, 24, 34, 204, 104, 54, 9, 9, 9],
    ];
    const png = buildPng(3, 5, 3, 2, rows, [0, 1, 2, 3, 4]);

    const image = decodePng(png);

    expect({ width: image.width, height: image.height }).toEqual({ width: 3, height: 5 });
    expect(pixel(image, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(pixel(image, 1, 1)).toEqual([201, 101, 51, 255]);
    expect(pixel(image, 2, 4)).toEqual([9, 9, 9, 255]);
  });

  it('серый файл разворачивается в RGBA — сравнивать всё равно по трём каналам', () => {
    const png = buildPng(
      2,
      2,
      1,
      0,
      [
        [0, 128],
        [255, 64],
      ],
      [0, 0],
    );

    const image = decodePng(png);

    expect(pixel(image, 1, 0)).toEqual([128, 128, 128, 255]);
    expect(pixel(image, 0, 1)).toEqual([255, 255, 255, 255]);
  });

  it('запись и чтение сходятся байт в байт по пикселям', () => {
    const data = new Uint8Array(2 * 2 * 4);
    data.set([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 0]);

    const image = decodePng(encodePng({ width: 2, height: 2, data }));

    expect([...image.data]).toEqual([...data]);
  });

  it('чужой файл — названная ошибка, а не мусор в пикселях', () => {
    expect(() => decodePng(Buffer.from('это не картинка'))).toThrow(PngFormatError);
  });

  it('палитра и чересстрочность отклоняются с причиной, а не молча', () => {
    const palette = buildPng(1, 1, 1, 3, [[0]], [0]);
    expect(() => decodePng(palette)).toThrow(/палитр/i);

    const interlaced = buildPng(1, 1, 3, 2, [[1, 2, 3]], [0]);
    // Ставим флаг чересстрочности в уже собранном файле: 12-й байт IHDR.
    interlaced[8 + 8 + 12] = 1;
    expect(() => decodePng(interlaced)).toThrow(/Adam7/);
  });

  it('обрезанный файл не притворяется картинкой', () => {
    const png = buildPng(
      2,
      2,
      3,
      2,
      [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
      ],
      [0, 0],
    );

    expect(() => decodePng(png.subarray(0, png.byteLength - 30))).toThrow(PngFormatError);
  });
});
