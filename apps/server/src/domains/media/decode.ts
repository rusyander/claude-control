import type { MediaImageMime } from '@agentdeck/contracts';
import { MEDIA_IMAGE_MAX_BYTES, mediaImageMimes } from '@agentdeck/contracts/media';
import { MediaError } from './errors.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Байты картинки из ответа модели.
 *
 * Тип берётся из САМИХ БАЙТОВ и сверяется с объявленным, а не наоборот. Причина
 * не в аккуратности: панель отдаёт этот файл обратно в браузер, и тип
 * содержимого, взятый со слов чужой стороны, — это дыра (тем же рассуждением
 * закрыт список типов у показа файлов проекта). Поэтому здесь два условия,
 * и оба обязательны: подпись байтов узнана И объявленный тип с ней согласен.
 */

interface Decoded {
  bytes: Buffer;
  mime: MediaImageMime;
  width?: number;
  height?: number;
}

/** Подписи, которые панель узнаёт. Список закрыт — как и список типов. */
function sniff(bytes: Buffer): MediaImageMime | undefined {
  if (bytes.length < 16) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** Размеры PNG — из IHDR, первого чанка формата. У остальных не читаем. */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function decodeBase64(data: string): Buffer {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0)
    throw coded(
      new MediaError(502, 'В ответе модели вместо картинки пустые байты'),
      'media-image-empty-bytes',
    );
  if (bytes.length > MEDIA_IMAGE_MAX_BYTES) {
    // Потолок — единственный отказ этого файла, который человек и правда
    // встречает, и до ревью Т13 он один из четырёх ехал без кода: английский
    // экран и телефон показывали русскую строку там, где справка обещает предел
    // по-английски.
    const limit = String(Math.round(MEDIA_IMAGE_MAX_BYTES / (1024 * 1024)));
    throw coded(
      new MediaError(502, `Картинка больше ${limit} МБ — панель её не сохраняет`),
      'media-image-too-large',
      { limit },
    );
  }
  return bytes;
}

function finish(bytes: Buffer, declared?: string): Decoded {
  const mime = sniff(bytes);
  if (!mime) {
    throw coded(
      new MediaError(502, 'Ответ модели не картинка: подпись файла панели не знакома'),
      'media-image-signature',
    );
  }
  // Объявленный тип спорит с байтами — отказ, а не тихое исправление: спор
  // означает, что одна из сторон соврала, и угадать, какая, нельзя.
  if (declared && declared !== mime) {
    throw coded(
      new MediaError(502, `Модель объявила ${declared}, а байты — ${mime}`),
      'media-image-mime-mismatch',
      { declared, mime },
    );
  }
  return { bytes, mime, ...(mime === 'image/png' ? (pngSize(bytes) ?? {}) : {}) };
}

/**
 * Часть ответа `chat/completions`: адрес вида `data:image/png;base64,…`.
 *
 * Адрес `http(s)` здесь НЕ скачивается: это был бы поход панели на адрес,
 * который назвала модель, — то есть чужой запрос нашими правами и наружу. Такой
 * ответ называется отказом (и это причина просить `b64_json` у ручки картинок).
 */
export function decodeDataUrl(url: string): Decoded {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url.trim());
  if (!match) {
    throw new MediaError(
      502,
      url.trim().startsWith('http')
        ? 'Контур вернул ссылку вместо самой картинки: по чужим адресам панель не ходит'
        : 'Часть ответа не похожа на картинку',
    );
  }
  const declared = (match[1] ?? '').toLowerCase();
  if (!(mediaImageMimes as readonly string[]).includes(declared)) {
    throw coded(
      new MediaError(502, `Тип ${declared} панель не показывает`),
      'media-image-type-unshown',
      { declared },
    );
  }
  return finish(decodeBase64(match[2] ?? ''), declared);
}

/** Ответ ручки картинок: `{ data: [{ b64_json }] }`. Тип объявлять там нечем. */
export function decodeBase64Image(data: string): Decoded {
  return finish(decodeBase64(data));
}
