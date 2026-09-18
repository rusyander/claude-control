import { describe, expect, it } from 'vitest';
import type { MediaImage, MediaImagePlan } from '@agentdeck/contracts';
import { mediaImageBlockers } from '@agentdeck/contracts/media';
import { en } from '../../shared/config/i18n/en';
import { ru } from '../../shared/config/i18n/ru';
import {
  formatBytes,
  imageCardLines,
  imageModeView,
  mediaChatId,
  mediaImagePath,
  planImageSubmit,
} from './mode';

/**
 * Режим «Картинка» на телефоне (Т9 MINOR-11): доступность и дорога берутся из
 * плана сервера как есть, телефон их не угадывает.
 */
const words = ru.composer.mode;

const raster: MediaImagePlan = {
  available: true,
  source: 'contour-images',
  title: 'Company',
  model: 'flux',
  promptSent: false,
};

const agent: MediaImagePlan = {
  available: true,
  source: 'agent',
  title: '',
  model: '',
  rasterReason: 'driver-none',
  promptSent: true,
};

describe('imageModeView', () => {
  it('запирает пункт без причины, пока план не приехал', () => {
    expect(imageModeView(undefined, words)).toEqual({ available: false, byAgent: false });
  });

  // Причины заводит сервер, и новая доезжает до телефона только словарём: пока
  // `gateway-failed` в нём не было, подпись у запертого пункта просто не
  // находилась — экран молчал о том, чего человеку ждать. Поэтому проверяется
  // ВЕСЬ список кодов, а не тот, что вспомнили.
  it('переводит каждую причину сервера — и запертый пункт, и отсутствие растра', () => {
    for (const language of [ru, en]) {
      const words = language.composer.mode;
      for (const reason of mediaImageBlockers) {
        expect(words.blocked[reason], `blocked.${reason}`).toBeTruthy();
        expect(words.noRaster[reason], `noRaster.${reason}`).toBeTruthy();
      }
    }
  });

  it('называет причину сервера словами, а без кода — общим «рисовать нечем»', () => {
    const blocked = { ...raster, available: false, reason: 'gateway-off' as const };
    expect(imageModeView(blocked, words)).toEqual({
      available: false,
      reasonText: 'Шлюз панели выключен, а запрос в контур идёт через него',
      byAgent: false,
    });
    const { reason: _reason, ...noCode } = blocked;
    expect(imageModeView(noCode, words).reasonText).toBe('Рисовать нечем');
  });

  it('дописывает отказ слушателя к нашей причине — и запертым пунктом, и без растра', () => {
    // Ревью Т13: панель дописывает `reasonDetail` (`withDetail`), телефон терял
    // его целиком. «Шлюз панели не поднялся» без слова о том, ЧЕМ именно, не
    // даёт человеку ни одного следующего шага.
    const blocked = {
      ...raster,
      available: false,
      reason: 'gateway-failed' as const,
      reasonDetail: 'порт 5199 занят',
    };
    expect(imageModeView(blocked, words).reasonText).toContain('порт 5199 занят');

    const noRaster = {
      ...raster,
      rasterReason: 'gateway-failed' as const,
      reasonDetail: 'порт 5199 занят',
    };
    expect(imageModeView(noRaster, words).sourceText).toContain('порт 5199 занят');
  });

  it('на растровой дороге говорит кто, какой моделью и что промпт не уезжает', () => {
    expect(imageModeView(raster, words)).toEqual({
      available: true,
      sourceText:
        'Company · flux · Промпт режима здесь не уезжает: у ручки картинок системного сообщения нет',
      byAgent: false,
    });
  });

  it('на дороге агента говорит про вектор и почему нет растра', () => {
    expect(imageModeView(agent, words)).toEqual({
      available: true,
      sourceText:
        'Нарисует агент разговора: вектор кодом, а не снимок · растра нет: этот контур картинок не рисует',
      byAgent: true,
    });
  });
});

describe('planImageSubmit', () => {
  it('ничего не делает с пустым полем, без плана и при запертом пункте', () => {
    expect(planImageSubmit(raster, '   ')).toBeUndefined();
    expect(planImageSubmit(undefined, 'кот')).toBeUndefined();
    expect(planImageSubmit({ ...raster, available: false }, 'кот')).toBeUndefined();
  });

  it('выбирает дорогу по источнику плана', () => {
    expect(planImageSubmit(raster, '  кот в шляпе ')).toEqual({
      road: 'image',
      prompt: 'кот в шляпе',
    });
    expect(planImageSubmit(agent, 'кот')).toEqual({ road: 'agent', topic: 'кот' });
  });
});

describe('карточка картинки', () => {
  const image: MediaImage = {
    id: '0123456789abcdef',
    chatId: 'abc',
    name: 'image.png',
    mime: 'image/png',
    sizeBytes: 204_800,
    width: 1024,
    height: 768,
    prompt: 'кот',
    model: 'flux',
    source: 'contour-images',
    createdAt: '2026-09-17T10:00:00.000Z',
  };

  it('подписывает модель, дорогу и размер', () => {
    expect(imageCardLines(image, words)).toEqual([
      'Нарисовано: flux · контур, ручка картинок',
      '1024×768, 200.0 KB',
    ]);
    const bare = { ...image, model: '', width: undefined, height: undefined, sizeBytes: 900 };
    expect(imageCardLines(bare, words)).toEqual(['Нарисовано: контур, ручка картинок', '900 B']);
  });

  it('берёт байты тем же адресом, что панель, и не привязывает к черновику', () => {
    expect(mediaImagePath('0123456789abcdef')).toBe('/media/images/0123456789abcdef');
    expect(mediaChatId('new-123')).toBe('');
    expect(mediaChatId('5f1c')).toBe('5f1c');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
