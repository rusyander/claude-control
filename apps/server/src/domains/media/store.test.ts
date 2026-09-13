import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MediaImage } from '@agentdeck/contracts';
import { MEDIA_KEEP_FILES } from '@agentdeck/contracts/media';
import { isMediaError, type MediaError } from './errors.ts';
import {
  assertId,
  imagePath,
  mediaDir,
  readImageBytes,
  readImageRecord,
  saveImage,
  trimImages,
} from './store.ts';

/**
 * Файлы картинок в каталоге данных.
 *
 * Здесь заперты три вещи: часть пути из запроса не выводит чтение за каталог,
 * потолок каталога работает по записям (галереи в задаче нет, удалять человеку
 * негде), а половинчатая пара файлов не превращается в карточку, которая ничего
 * не покажет.
 */

let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'media-store-'));
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

function record(id: string): MediaImage {
  return {
    id,
    chatId: 'c',
    name: `image-${id}.png`,
    mime: 'image/png',
    sizeBytes: 3,
    prompt: 'кот',
    model: 'm',
    source: 'endpoint',
    createdAt: '2026-09-12T10:00:00.000Z',
  };
}

function thrown(run: () => unknown): MediaError {
  try {
    run();
  } catch (error) {
    if (isMediaError(error)) return error;
    throw error;
  }
  throw new Error('отказа не было');
}

/** Идентификатор нужной длины: `assertId` пропускает только такие. */
function id(seed: number): string {
  return seed.toString(16).padStart(16, '0');
}

describe('assertId: часть пути, пришедшая из запроса', () => {
  it('пропускает только то, что панель сама и выдаёт', () => {
    expect(assertId('0123456789abcdef')).toBe('0123456789abcdef');
  });

  it('выход из каталога, слэши и расширения отвергаются кодом 400', () => {
    for (const bad of ['../../state', 'a/b', '0123456789abcdef.png', 'ZZZZ', '', 'abc']) {
      expect(thrown(() => assertId(bad)).status).toBe(400);
    }
  });

  it('путь к файлу собирается из проверенного имени и типа из закрытого списка', () => {
    expect(imagePath(appData, record('0123456789abcdef'))).toBe(
      join(mediaDir(appData), '0123456789abcdef.png'),
    );
  });
});

describe('saveImage и чтение', () => {
  it('байты и запись ложатся рядом и читаются обратно', () => {
    const bytes = Buffer.from([1, 2, 3]);

    const saved = saveImage(appData, record(id(1)), bytes);

    expect(readImageRecord(appData, saved.id)).toMatchObject({ id: saved.id, prompt: 'кот' });
    expect(readImageBytes(appData, saved)).toEqual(bytes);
  });

  it('битая запись — это «картинки нет», а не 500', () => {
    mkdirSync(mediaDir(appData), { recursive: true });
    writeFileSync(join(mediaDir(appData), `${id(2)}.json`), '{не json');

    expect(readImageRecord(appData, id(2))).toBeUndefined();
  });

  it('живая запись без файла байтов — честный 404, а не пустая картинка', () => {
    const saved = saveImage(appData, record(id(3)), Buffer.from([1, 2, 3]));
    rmSync(imagePath(appData, saved));

    expect(thrown(() => readImageBytes(appData, saved)).status).toBe(404);
  });
});

describe('trimImages: потолок каталога', () => {
  it('держит последние картинки и уносит байты вместе с записью', () => {
    // На одну больше предела: уйти должна ровно самая старая, и вместе с её
    // файлом — иначе каталог растёт молча, а человеку негде это увидеть.
    const total = MEDIA_KEEP_FILES + 1;
    for (let index = 0; index < total; index += 1) {
      const saved = saveImage(appData, record(id(index + 1)), Buffer.from([index]));
      // Порядок задаётся временем записи: в тесте файлы рождаются в одну
      // миллисекунду, и без явных отметок «последние» определялись бы случаем.
      const at = new Date(2026, 0, 1, 0, 0, index);
      utimesSync(join(mediaDir(appData), `${saved.id}.json`), at, at);
    }

    trimImages(appData);

    expect(readImageRecord(appData, id(1))).toBeUndefined();
    expect(existsSync(join(mediaDir(appData), `${id(1)}.png`))).toBe(false);
    expect(readImageRecord(appData, id(total))).toBeDefined();
  });

  it('байты без записи — сирота от прерванной записи, подметается сразу', () => {
    mkdirSync(mediaDir(appData), { recursive: true });
    const orphan = join(mediaDir(appData), `${id(9)}.png`);
    writeFileSync(orphan, Buffer.from([1]));

    trimImages(appData);

    expect(existsSync(orphan)).toBe(false);
  });

  it('чужие файлы в каталоге не трогает', () => {
    mkdirSync(mediaDir(appData), { recursive: true });
    const alien = join(mediaDir(appData), 'readme.txt');
    writeFileSync(alien, 'не наше');

    trimImages(appData);

    expect(existsSync(alien)).toBe(true);
  });
});
