import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Минимальный ZIP: сборка и разбор архива без внешних зависимостей.
 *
 * Зачем свой: перенос окружения кладёт конфигурацию провайдера в один файл,
 * который пользователь уносит на другую машину. Ради этого тянуть в сервер
 * пакет-архиватор незачем — формат ZIP описан открыто, а нам нужны ровно две
 * операции: собрать записи в буфер и разобрать буфер обратно. Zip выбран вместо
 * tar потому, что Windows открывает его двойным щелчком без сторонних программ.
 *
 * ОГРАНИЧЕНИЯ (осознанные, fail-closed):
 *   - без Zip64: архив и любая запись в нём должны быть меньше 4 ГБ, иначе
 *     сборка падает с внятной ошибкой, а не пишет битый файл;
 *   - только методы `store` (0) и `deflate` (8) — всё остальное при разборе
 *     отвергается;
 *   - шифрование не поддерживается ни на запись, ни на чтение.
 *
 * Дата записей приходит снаружи: домен подставляет момент экспорта, тест —
 * фиксированное значение, поэтому одинаковый вход даёт побайтово одинаковый
 * архив.
 */

/** Одна запись архива: путь внутри архива (всегда через прямой слэш) и содержимое. */
export interface ZipEntry {
  path: string;
  data: Buffer;
}

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;

/** Флаг «имена и комментарии в UTF-8» — иначе кириллица в путях читается мусором. */
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Предел формата без Zip64. Больше — честная ошибка вместо битого архива. */
const MAX_SIZE = 0xffffffff;

/** Собирает ZIP-архив из записей. `modifiedAt` попадает в заголовки всех записей. */
export function createZip(entries: ZipEntry[], modifiedAt: Date): Buffer {
  const { time, date } = toDosDateTime(modifiedAt);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(normalizeEntryPath(entry.path), 'utf8');
    const raw = entry.data;
    if (raw.length > MAX_SIZE) {
      throw zipError(`Файл «${entry.path}» больше 4 ГБ — формат ZIP без Zip64 его не вместит.`);
    }

    // Сжимаем, но если сжатое не меньше исходного (уже сжатые картинки, архивы),
    // кладём как есть: так файл не растёт от «сжатия».
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIGNATURE_LOCAL, 0);
    local.writeUInt16LE(20, 4); // версия, нужная для распаковки
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field отсутствует
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIGNATURE_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // версия создателя
    central.writeUInt16LE(20, 6); // версия для распаковки
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // номер диска
    central.writeUInt16LE(0, 36); // внутренние атрибуты
    central.writeUInt32LE(0, 38); // внешние атрибуты
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
    if (offset > MAX_SIZE) {
      throw zipError('Архив вышел больше 4 ГБ — формат ZIP без Zip64 его не вместит.');
    }
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIGNATURE_END, 0);
  end.writeUInt16LE(0, 4); // номер диска
  end.writeUInt16LE(0, 6); // диск с началом каталога
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // комментарий архива

  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Разбирает архив по центральному каталогу (а не по цепочке локальных
 * заголовков): каталог — единственная надёжная опись, локальные заголовки могут
 * нести нулевые размеры и переносить их в data descriptor.
 *
 * Контрольная сумма каждой записи проверяется: подсунутый или побитый архив
 * должен упасть здесь, а не после записи файлов на диск.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  const endOffset = findEndRecord(buffer);
  const count = buffer.readUInt16LE(endOffset + 10);
  let pointer = buffer.readUInt32LE(endOffset + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== SIGNATURE_CENTRAL) {
      throw zipError('Повреждён центральный каталог архива.');
    }

    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const originalSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const path = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    entries.push(
      readLocalEntry(buffer, { path, localOffset, method, compressedSize, originalSize, crc }),
    );
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

interface LocalEntryHeader {
  path: string;
  localOffset: number;
  method: number;
  compressedSize: number;
  originalSize: number;
  crc: number;
}

function readLocalEntry(buffer: Buffer, header: LocalEntryHeader): ZipEntry {
  const { localOffset, path } = header;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIGNATURE_LOCAL) {
    throw zipError(`Повреждён заголовок записи «${path}».`);
  }

  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const payload = buffer.subarray(start, start + header.compressedSize);
  if (payload.length !== header.compressedSize) {
    throw zipError(`Запись «${path}» обрывается за концом архива.`);
  }

  let data: Buffer;
  if (header.method === METHOD_STORE) {
    data = Buffer.from(payload);
  } else if (header.method === METHOD_DEFLATE) {
    data = inflateRawSync(payload);
  } else {
    throw zipError(`Запись «${path}» сжата неподдерживаемым методом (${header.method}).`);
  }

  if (data.length !== header.originalSize || crc32(data) !== header.crc) {
    throw zipError(`Запись «${path}» не прошла проверку целостности.`);
  }
  return { path, data };
}

/**
 * Ищет запись конца каталога с хвоста: у неё переменный комментарий, поэтому
 * фиксированного места нет. Комментарий ограничен 64 КБ — дальше не смотрим.
 */
function findEndRecord(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIGNATURE_END) return offset;
  }
  throw zipError('Это не ZIP-архив: не найдена запись конца каталога.');
}

/**
 * Путь внутри архива: только прямые слэши, без ведущего слэша и без `..` — такой
 * архив безопасно распаковывать любым распаковщиком, включая наш собственный.
 */
function normalizeEntryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw zipError(`Недопустимое имя записи архива: «${path}».`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw zipError(`Имя записи архива выходит за его пределы: «${path}».`);
  }
  return normalized;
}

/** Время и дата в формате MS-DOS: секунды с шагом 2, год от 1980. */
function toDosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getFullYear());
  const time =
    (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  return { time, date };
}

let crcTable: Uint32Array | undefined;

/** Таблица CRC-32 (полином 0xEDB88320) — строится один раз при первом обращении. */
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 буфера — контрольная сумма, которую требует формат ZIP. */
export function crc32(data: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipError(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_archive' });
}
