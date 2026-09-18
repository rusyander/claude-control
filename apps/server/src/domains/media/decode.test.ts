import { describe, expect, it } from 'vitest';
import { MEDIA_IMAGE_MAX_BYTES } from '@agentdeck/contracts/media';
import { decodeBase64Image, decodeDataUrl } from './decode.ts';
import { isMediaError, type MediaError } from './errors.ts';

/**
 * Байты картинки из чужого ответа.
 *
 * Проверяется ровно то, ради чего файл заведён: тип берётся из САМИХ БАЙТОВ, а не
 * со слов чужой стороны (панель отдаёт этот файл обратно в браузер), спор
 * объявленного типа с подписью — отказ, а не тихое исправление, и ссылка вместо
 * байтов не превращается в поход панели по чужому адресу.
 */

function thrown(run: () => unknown): MediaError {
  try {
    run();
  } catch (error) {
    if (isMediaError(error)) return error;
    throw error;
  }
  throw new Error('отказа не было');
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG с настоящим IHDR: размеры панель читает именно оттуда. */
function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(13, 0);
  head.write('IHDR', 4, 'latin1');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([PNG_HEAD, head, ihdr, Buffer.alloc(4), Buffer.alloc(16)]);
}

describe('decodeDataUrl: часть ответа модели', () => {
  it('PNG узнаётся по подписи, размеры — из IHDR', () => {
    const bytes = png(640, 480);

    const decoded = decodeDataUrl(`data:image/png;base64,${bytes.toString('base64')}`);

    expect(decoded.mime).toBe('image/png');
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(480);
    expect(decoded.bytes).toEqual(bytes);
  });

  it('объявленный тип спорит с байтами — отказ, а не тихое исправление', () => {
    // Спор означает, что одна из сторон соврала, и угадать, какая, нельзя.
    const error = thrown(() =>
      decodeDataUrl(`data:image/jpeg;base64,${png(2, 2).toString('base64')}`),
    );

    expect(error.status).toBe(502);
    expect(error.message).toContain('image/jpeg');
    expect(error.message).toContain('image/png');
  });

  it('подпись, которой панель не знает, — не картинка', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    const error = thrown(() => decodeDataUrl(`data:image/png;base64,${svg.toString('base64')}`));

    expect(error.message).toContain('подпись файла панели не знакома');
  });

  it('тип вне закрытого списка отвергается до разбора байтов', () => {
    const error = thrown(() => decodeDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='));

    expect(error.message).toContain('image/svg+xml');
  });

  it('ссылка http вместо байтов — названный отказ, а не скачивание', () => {
    // Поход по адресу, который назвала модель, — это чужой запрос нашими правами.
    const error = thrown(() => decodeDataUrl('https://cdn.example/kitten.png'));

    expect(error.message).toContain('по чужим адресам панель не ходит');
  });

  it('пустые байты — отказ, а не файл нулевой длины', () => {
    expect(thrown(() => decodeDataUrl('data:image/png;base64,')).message).toContain(
      'не похожа на картинку',
    );
    expect(thrown(() => decodeBase64Image('')).message).toContain('пустые байты');
  });

  it('картинка больше потолка не сохраняется, и потолок назван в отказе', () => {
    const big = Buffer.concat([PNG_HEAD, Buffer.alloc(MEDIA_IMAGE_MAX_BYTES)]);

    const error = thrown(() => decodeBase64Image(big.toString('base64')));

    expect(error.message).toContain('8 МБ');
    // Единственный отказ этого файла, который человек и правда встречает, ехал
    // без кода: `server-text` переводит ТОЛЬКО по коду, и английский экран с
    // телефоном показывали русскую строку про предел, который справка обещает
    // по-английски (ревью Т13). Потолок уезжает параметром — иначе словарь
    // клиента держал бы число, живущее в контракте.
    expect(error).toMatchObject({
      messageCode: 'media-image-too-large',
      params: { limit: '8' },
    });
  });
});

describe('decodeBase64Image: ответ ручки картинок', () => {
  it('JPEG и WebP узнаются по своим подписям', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'latin1'),
      Buffer.alloc(16),
    ]);

    expect(decodeBase64Image(jpeg.toString('base64')).mime).toBe('image/jpeg');
    expect(decodeBase64Image(webp.toString('base64')).mime).toBe('image/webp');
    // Размеры панель читает только у PNG — у остальных их в записи нет вовсе,
    // и врать числом из воздуха она не станет.
    expect(decodeBase64Image(jpeg.toString('base64')).width).toBeUndefined();
  });
});
