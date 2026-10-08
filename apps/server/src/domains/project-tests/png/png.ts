import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Чтение и запись PNG своими руками.
 *
 * Зависимости здесь нет намеренно: сравнение скриншотов нужно ровно в одном
 * месте панели, а `sharp`/`pngjs` тянут за собой либо нативную сборку, либо
 * ещё один пакет в сервер, который и так обходится встроенным `node:zlib`.
 * Всё, что делает браузерный скриншот, — это несжатый RGB(A) под deflate, а
 * распаковка и фильтры PNG описаны в спецификации на полторы страницы.
 *
 * Поддержаны 8- и 16-битные оттенки серого и RGB(A) без чересстрочности —
 * то, что отдают Playwright, Chrome DevTools и любой оконный скриншотер.
 * Всё остальное (палитра, Adam7) НЕ угадывается: такой файл получает
 * названную ошибку, потому что молчаливый «эталон совпал» на нераспознанном
 * файле хуже, чем честный отказ.
 */

/** Картинка в памяти: всегда RGBA по 8 бит на канал — с ней и сравниваем. */
export interface PngImage {
  width: number;
  height: number;
  /** `width * height * 4` байт: R, G, B, A. */
  data: Uint8Array;
}

/** Файл не PNG, битый или в форме, которую мы не разбираем. */
export class PngFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngFormatError';
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Каналов на пиксель по типу цвета PNG (индекс = тип). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Таблица CRC32 — нужна только записи; считается один раз на процесс. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Предсказатель Paeth — единственный фильтр PNG, который не выводится в строку. */
function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dCorner = Math.abs(estimate - corner);
  if (dLeft <= dUp && dLeft <= dCorner) return left;
  return dUp <= dCorner ? up : corner;
}

/** Заголовок IHDR — всё, что нужно знать о форме данных. */
interface Header {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: number;
}

function readHeader(data: Buffer): Header {
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    depth: data.readUInt8(8),
    colorType: data.readUInt8(9),
    interlace: data.readUInt8(12),
  };
}

/**
 * Снять фильтры со строк развёрнутого потока. Каждая строка PNG начинается
 * байтом фильтра и опирается на СОСЕДЕЙ — левый пиксель и строку выше, — поэтому
 * распаковать её отдельно нельзя, только по порядку.
 */
function unfilter(raw: Buffer, bytesPerPixel: number, rowBytes: number, height: number): Buffer {
  const out = Buffer.allocUnsafe(rowBytes * height);
  let position = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[position];
    position += 1;
    const start = row * rowBytes;
    const previous = start - rowBytes;
    for (let index = 0; index < rowBytes; index += 1) {
      const value = raw[position + index] ?? 0;
      const left = index >= bytesPerPixel ? out[start + index - bytesPerPixel]! : 0;
      const up = row > 0 ? out[previous + index]! : 0;
      const corner = row > 0 && index >= bytesPerPixel ? out[previous + index - bytesPerPixel]! : 0;
      let restored: number;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) restored = value + paeth(left, up, corner);
      else throw new PngFormatError(`Неизвестный фильтр строки PNG: ${String(filter)}.`);
      out[start + index] = restored & 0xff;
    }
    position += rowBytes;
  }
  return out;
}

/** Развернуть строки в RGBA независимо от исходного числа каналов и глубины. */
function toRgba(pixels: Buffer, header: Header, channels: number): Uint8Array {
  const { width, height, depth, colorType } = header;
  const step = depth === 16 ? 2 : 1;
  const data = new Uint8Array(width * height * 4);
  const rowBytes = width * channels * step;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * rowBytes + x * channels * step;
      // 16 бит на канал схлопываем до 8: старший байт — это и есть значение с
      // точностью до 1/255, а сравнение скриншотов тоньше не различает.
      const channel = (index: number): number => pixels[source + index * step]!;
      const target = (y * width + x) * 4;
      if (colorType === 0 || colorType === 4) {
        const gray = channel(0);
        data[target] = gray;
        data[target + 1] = gray;
        data[target + 2] = gray;
        data[target + 3] = colorType === 4 ? channel(1) : 255;
      } else {
        data[target] = channel(0);
        data[target + 1] = channel(1);
        data[target + 2] = channel(2);
        data[target + 3] = colorType === 6 ? channel(3) : 255;
      }
    }
  }
  return data;
}

/** Разобрать PNG в RGBA. Любая непонятная форма — названная ошибка. */
export function decodePng(buffer: Buffer): PngImage {
  if (buffer.byteLength < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngFormatError('Это не PNG: подпись файла другая.');
  }

  let offset = 8;
  let header: Header | undefined;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.byteLength) throw new PngFormatError('PNG обрывается посреди блока.');
    if (type === 'IHDR') header = readHeader(buffer.subarray(start, end));
    else if (type === 'IDAT') idat.push(buffer.subarray(start, end));
    else if (type === 'IEND') break;
    offset = end + 4;
  }

  if (!header) throw new PngFormatError('В PNG нет заголовка IHDR.');
  if (header.width <= 0 || header.height <= 0) throw new PngFormatError('PNG нулевого размера.');
  if (header.interlace !== 0) {
    throw new PngFormatError('Чересстрочный PNG (Adam7) не поддерживается — пересохрани обычным.');
  }
  const channels = CHANNELS[header.colorType];
  if (!channels) {
    throw new PngFormatError(
      `PNG с палитрой или неизвестным типом цвета (${header.colorType}) не поддерживается — нужен RGB, RGBA или серый.`,
    );
  }
  if (header.depth !== 8 && header.depth !== 16) {
    throw new PngFormatError(
      `PNG с глубиной ${header.depth} бит не поддерживается — нужен 8 или 16.`,
    );
  }
  if (idat.length === 0) throw new PngFormatError('В PNG нет данных изображения.');

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new PngFormatError(`Данные PNG не распаковались: ${(error as Error).message}`);
  }

  const step = header.depth === 16 ? 2 : 1;
  const bytesPerPixel = channels * step;
  const rowBytes = header.width * bytesPerPixel;
  if (raw.byteLength < (rowBytes + 1) * header.height) {
    throw new PngFormatError('PNG короче, чем обещает его заголовок.');
  }

  const pixels = unfilter(raw, bytesPerPixel, rowBytes, header.height);
  return { width: header.width, height: header.height, data: toRgba(pixels, header, channels) };
}

/** Блок PNG: длина, тип, данные, контрольная сумма. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Собрать RGBA обратно в PNG. Фильтр всегда нулевой: картинка-разница живёт
 * минуты и открывается человеком один раз, а подбор фильтров ради лишних
 * процентов сжатия стоил бы прохода по каждой строке пять раз.
 */
export function encodePng(image: PngImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new PngFormatError('Размер данных не совпадает с размером картинки.');
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);

  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (rowBytes + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + row * rowBytes, rowBytes).copy(
      raw,
      row * (rowBytes + 1) + 1,
    );
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
