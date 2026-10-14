import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Заголовок GGUF: что модель такое, не загружая её.
 *
 * Нужен в двух местах. Импорт из Ollama: файл чужой, каталог о нём ничего не
 * знает, а слой предсказания нескольких токенов (`nextn_predict_layers`) решает,
 * звать ли сервер с `--spec-type draft-mtp` (без слоя в файле сервер с этим
 * флагом не поднимется). И сверка каталога: слои, KV-головы и длина головы
 * читаются из файла, а не из карточки модели.
 *
 * Читается только начало файла и только пока идут ключи модели: словарь токенов
 * (`tokenizer.*`) — это мегабайты, ему здесь нечего делать, а идёт он после всех
 * ключей архитектуры.
 */

export interface GgufFacts {
  architecture: string;
  /** Слоёв всего. */
  blockCount: number;
  contextLength: number;
  headCountKv: number;
  keyLength: number;
  /** Слоёв предсказания нескольких токенов; нет ключа — 0. */
  nextn: number;
  /** Каждый N-й слой — полное внимание (гибридные Qwen3.5+); нет ключа — 0. */
  fullAttentionInterval: number;
  /** Ширина слоя и число голов внимания: длина головы, когда `key_length` не записан. */
  embeddingLength: number;
  headCount: number;
  /** Эксперты смеси: всего и на токен; у плотной модели 0. */
  expertCount: number;
  expertUsed: number;
  /** `general.file_type` — номер квантования файла (LLAMA_FTYPE); нет ключа — не задан. */
  fileType?: number;
  /**
   * Состояние слоёв не сдвигается как KV-кеш: гибрид с линейным вниманием или
   * рекуррентная модель (ключи `ssm.*` / `wkv.*`, `full_attention_interval`). Сервер
   * на такой модели отключает `--cache-reuse` сам и пишет об этом в журнал (замер
   * 14.10 на Qwen3.6 27B), так что флаг ей не передаётся.
   */
  recurrent: boolean;
}

/** Архитектуры с рекуррентным состоянием по имени — на случай, когда ключей `ssm.*` в заголовке нет. */
const RECURRENT_ARCHITECTURES =
  /^(mamba|rwkv|jamba|falcon-h1|nemotron_h|granitehybrid|lfm2|qwen3next|qwen35)/;

/** Номера `general.file_type` → имя квантования, как в llama.cpp (`LLAMA_FTYPE_MOSTLY_*`). */
const FILE_TYPES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  36: 'TQ1_0',
  37: 'TQ2_0',
  38: 'MXFP4',
};

/** Имя квантования по номеру из заголовка; неизвестный номер — `undefined`. */
export function quantNameOf(fileType: number | undefined): string | undefined {
  return fileType === undefined ? undefined : FILE_TYPES[fileType];
}

/** Сколько байт начала файла читается: ключи архитектуры идут раньше словаря токенов. */
export const GGUF_HEAD_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = GGUF_HEAD_BYTES;

class Reader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  u32(): number {
    const value = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): number {
    const value = Number(this.buf.readBigUInt64LE(this.offset));
    this.offset += 8;
    return value;
  }

  str(): string {
    const length = this.u64();
    const value = this.buf.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }

  value(type: number): string | number | boolean | undefined {
    switch (type) {
      case 0:
      case 1:
      case 7:
        this.skip(1);
        return undefined;
      case 2:
      case 3:
        this.skip(2);
        return undefined;
      case 4:
        return this.u32();
      case 5:
        this.skip(4);
        return undefined;
      case 6:
        this.skip(4);
        return undefined;
      case 8:
        return this.str();
      case 9: {
        // Массив: тип элементов и их число. Нужные нам ключи — не массивы, так что
        // пропускаем, не разбирая.
        const itemType = this.u32();
        const count = this.u64();
        for (let i = 0; i < count; i += 1) this.value(itemType);
        return undefined;
      }
      case 10:
        return this.u64();
      case 11:
      case 12:
        this.skip(8);
        return undefined;
      default:
        throw new Error(`GGUF value type ${type}`);
    }
  }
}

/** Типы тензоров ggml (`enum ggml_type`) → имя; нужны для файла без `general.file_type`. */
const GGML_TYPES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  10: 'Q2_K',
  11: 'Q3_K',
  12: 'Q4_K',
  13: 'Q5_K',
  14: 'Q6_K',
  16: 'IQ2_XXS',
  17: 'IQ2_XS',
  18: 'IQ3_XXS',
  19: 'IQ1_S',
  20: 'IQ4_NL',
  21: 'IQ3_S',
  22: 'IQ2_S',
  23: 'IQ4_XS',
  29: 'IQ1_M',
  30: 'BF16',
};

/** Таблица тензоров лежит после ключей и словаря: читаем начало файла с запасом. */
const TENSOR_HEAD_BYTES = 64 * 1024 * 1024;

/**
 * Основной тип весов файла — по таблице тензоров, когда `general.file_type` не записан
 * (Ollama его при сборке выбрасывает). Берётся тип, на который приходится больше всего
 * элементов у матриц (`n_dims` ≥ 2). Это именно ТИП ВЕСОВ (`Q4_K`), а не имя смеси
 * (`Q4_K_M` / `Q4_K_S` / `UD-Q4_K_XL`): по типам тензоров смесь не определить, и придумывать
 * её имя нельзя. Не прочитался или тип неизвестен — `undefined`.
 */
export function readGgufWeightType(path: string): string | undefined {
  let fd: number | undefined;
  let buf: Buffer;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    buf = Buffer.allocUnsafe(Math.min(size, TENSOR_HEAD_BYTES));
    const read = readSync(fd, buf, 0, buf.length, 0);
    buf = buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return parseGgufWeightType(buf);
}

export function parseGgufWeightType(buf: Buffer): string | undefined {
  if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'GGUF') return undefined;
  const reader = new Reader(buf);
  try {
    reader.skip(4);
    reader.u32();
    const tensors = reader.u64();
    const count = reader.u64();
    for (let i = 0; i < count; i += 1) {
      reader.str();
      reader.value(reader.u32());
    }
    const elements = new Map<number, number>();
    for (let i = 0; i < tensors; i += 1) {
      reader.str();
      const dimCount = reader.u32();
      let total = 1;
      for (let d = 0; d < dimCount; d += 1) total *= reader.u64();
      const type = reader.u32();
      reader.u64();
      if (dimCount >= 2) elements.set(type, (elements.get(type) ?? 0) + total);
    }
    const [top] = [...elements.entries()].sort((a, b) => b[1] - a[1]);
    return top ? GGML_TYPES[top[0]] : undefined;
  } catch {
    return undefined;
  }
}

/** Файл — GGUF? Четыре байта сигнатуры; всё остальное — не модель llama.cpp. */
export function isGguf(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    return head.toString('latin1') === 'GGUF';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Разобрать ключи модели из начала файла; не GGUF или оборванный заголовок — `undefined`. */
export function readGgufFacts(path: string): GgufFacts | undefined {
  let fd: number | undefined;
  let buf: Buffer;
  try {
    fd = openSync(path, 'r');
    buf = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    buf = buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return parseGgufFacts(buf);
}

/**
 * То же по уже прочитанным байтам: «Любая модель» берёт начало файла с Hugging
 * Face диапазоном, не скачивая гигабайты ради нескольких ключей.
 */
export function parseGgufFacts(buf: Buffer): GgufFacts | undefined {
  if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'GGUF') return undefined;
  const reader = new Reader(buf);
  try {
    reader.skip(4);
    reader.u32();
    reader.u64();
    const count = reader.u64();
    const kv = new Map<string, string | number | boolean>();
    for (let i = 0; i < count; i += 1) {
      const key = reader.str();
      // Словарь идёт после всех ключей архитектуры: дальше нам читать нечего.
      if (key.startsWith('tokenizer.')) break;
      const value = reader.value(reader.u32());
      if (value !== undefined) kv.set(key, value);
    }
    const architecture = String(kv.get('general.architecture') ?? '');
    const num = (suffix: string): number => {
      const value = kv.get(`${architecture}.${suffix}`);
      return typeof value === 'number' ? value : 0;
    };
    if (!architecture) return undefined;
    const recurrentKey = [...kv.keys()].some(
      (key) => key.startsWith(`${architecture}.ssm.`) || key.startsWith(`${architecture}.wkv.`),
    );
    return {
      architecture,
      recurrent:
        recurrentKey ||
        num('full_attention_interval') > 0 ||
        RECURRENT_ARCHITECTURES.test(architecture),
      blockCount: num('block_count'),
      contextLength: num('context_length'),
      headCountKv: num('attention.head_count_kv'),
      keyLength: num('attention.key_length'),
      nextn: num('nextn_predict_layers'),
      fullAttentionInterval: num('full_attention_interval'),
      embeddingLength: num('embedding_length'),
      headCount: num('attention.head_count'),
      expertCount: num('expert_count'),
      expertUsed: num('expert_used_count'),
      ...(typeof kv.get('general.file_type') === 'number'
        ? { fileType: kv.get('general.file_type') as number }
        : {}),
    };
  } catch {
    return undefined;
  }
}
