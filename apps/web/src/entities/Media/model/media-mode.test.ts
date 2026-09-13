import { describe, it, expect } from 'vitest';
import { mediaImageBlockers } from '@agentdeck/contracts';
import { mediaDeckBlockers } from '@agentdeck/contracts/media-deck';
import { ru } from '@shared/config/i18n/ru';
import { deckModeView, imageModeView } from './media-mode';

/**
 * Слова доступности режимов «Картинка» и «Презентация».
 *
 * Проверяются НЕ выдуманные строки, а сам словарь панели: переводчик здесь
 * достаёт ключ из `ru`, поэтому забытый текст причины краснит этот тест, а не
 * оставляет на экране «chat.mode.blocked.no-model» вместо объяснения.
 */

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, ru);

/** Перевод как у i18next: подстановка `{{name}}`, ключ наружу при промахе. */
const t = (key: string, values?: Record<string, string>): string => {
  const text = lookup(key);
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values?.[name] ?? '');
};

describe('слова режима «Картинка»', () => {
  it('план ещё не приехал — пункт заперт, но причина не выдумывается', () => {
    expect(imageModeView(undefined, t)).toEqual({ available: false });
  });

  it('у каждой причины отказа есть свой текст в словаре', () => {
    for (const reason of mediaImageBlockers) {
      const view = imageModeView(
        { available: false, title: '', model: '', reason, promptSent: false },
        t,
      );
      expect(view.available).toBe(false);
      // Ключ, вернувшийся самим собой, и есть забытый текст — именно его человек
      // прочёл бы красной строкой под запертым пунктом.
      expect(view.reasonText).toBeTruthy();
      expect(view.reasonText).not.toContain('chat.mode.blocked');
    }
  });

  it('недоступность без кода причины оставляет общее «рисовать нечем»', () => {
    const view = imageModeView({ available: false, title: '', model: '', promptSent: false }, t);

    expect(view).toEqual({ available: false });
  });

  it('доступный маршрут называет, кто и какой моделью нарисует', () => {
    const view = imageModeView(
      {
        available: true,
        source: 'contour-chat',
        title: 'EnterprisePlatform · dev',
        model: 'enterprise-platform-image',
        promptSent: true,
      },
      t,
    );

    expect(view.available).toBe(true);
    expect(view.sourceText).toBe('EnterprisePlatform · dev · enterprise-platform-image');
    expect(view.reasonText).toBeUndefined();
  });

  it('маршрут без модели не выдумывает её имя', () => {
    const view = imageModeView(
      { available: true, source: 'endpoint', title: 'Свой эндпоинт', model: '', promptSent: true },
      t,
    );

    expect(view.sourceText).toBe('Свой эндпоинт');
  });

  it('дорога без системного сообщения говорит, что промпт режима не уедет', () => {
    const view = imageModeView(
      {
        available: true,
        source: 'contour-images',
        title: 'EnterprisePlatform · dev',
        model: 'sd-xl',
        promptSent: false,
      },
      t,
    );

    // Молчание здесь читалось бы как «моя правка промпта не сработала»: правка
    // жива, просто у ручки картинок системного сообщения нет вовсе.
    expect(view.sourceText).toContain('EnterprisePlatform · dev · sd-xl');
    expect(view.sourceText).toContain(ru.chat.mode.promptSkipped);
  });

  it('дорога агента называет вектор и причину, по которой нет растра', () => {
    const view = imageModeView(
      {
        available: true,
        source: 'agent',
        title: 'Агент разговора',
        model: '',
        rasterReason: 'driver-none',
        promptSent: true,
      },
      t,
    );

    expect(view.available).toBe(true);
    // Про вектор сказано словами: человек, ждущий фотографии, иначе считает
    // ответ поломкой. А причина отсутствия РАСТРА стоит рядом с работающей
    // дорогой, а не вместо неё — чинится именно она.
    expect(view.sourceText).toContain(ru.chat.mode.sourceAgent);
    expect(view.sourceText).toContain(ru.chat.mode.noRaster['driver-none']);
    expect(view.sourceText).not.toContain('Агент разговора · ');
  });

  it('у каждой причины отсутствия растра есть свой текст', () => {
    for (const reason of mediaImageBlockers) {
      const view = imageModeView(
        {
          available: true,
          source: 'agent',
          title: '',
          model: '',
          rasterReason: reason,
          promptSent: true,
        },
        t,
      );

      expect(view.sourceText).not.toContain('chat.mode.noRaster');
    }
  });
});

describe('слова режима «Презентация»', () => {
  it('план ещё не приехал — пункт заперт без выдуманной причины', () => {
    expect(deckModeView(undefined, t)).toEqual({ available: false });
  });

  it('у каждой причины отказа есть свой текст в словаре', () => {
    for (const reason of mediaDeckBlockers) {
      const view = deckModeView(
        { available: false, title: '', model: '', reason, pdf: { available: false } },
        t,
      );

      expect(view.available).toBe(false);
      expect(view.reasonText).toBeTruthy();
      expect(view.reasonText).not.toContain('chat.mode.noDeck');
    }
  });

  it('недоступность без кода причины оставляет общее «собирать нечем»', () => {
    const view = deckModeView(
      { available: false, title: '', model: '', pdf: { available: false } },
      t,
    );

    expect(view).toEqual({ available: false });
  });

  it('дорога агента называет диктовку, а не модель', () => {
    const view = deckModeView(
      {
        available: true,
        source: 'agent',
        title: 'Агент разговора',
        model: '',
        pdf: { available: true },
      },
      t,
    );

    expect(view.available).toBe(true);
    expect(view.sourceText).toBe(ru.chat.mode.deckSourceAgent);
  });

  it('контур назван вместе с моделью, которая надиктует', () => {
    const view = deckModeView(
      {
        available: true,
        source: 'contour',
        title: 'EnterprisePlatform · dev',
        model: 'qwen2.5',
        pdf: { available: true },
      },
      t,
    );

    expect(view.sourceText).toBe('EnterprisePlatform · dev · qwen2.5');
  });

  it('машина без браузера говорит про PDF заранее, а не отказом на кнопке', () => {
    const view = deckModeView(
      {
        available: true,
        source: 'agent',
        title: 'Агент разговора',
        model: '',
        pdf: { available: false, reason: 'no-browser' },
      },
      t,
    );

    // Режим при этом доступен: HTML и PPTX получаются всегда, и запирать его
    // из-за одного вида файла было бы неправдой.
    expect(view.available).toBe(true);
    expect(view.sourceText).toContain(ru.chat.mode.noPdf['no-browser']);
  });

  it('PDF недоступен без кода причины — говорим про браузер, а не молчим', () => {
    const view = deckModeView(
      {
        available: true,
        source: 'contour',
        title: 'EnterprisePlatform',
        model: 'm',
        pdf: { available: false },
      },
      t,
    );

    expect(view.sourceText).toContain(ru.chat.mode.noPdf['no-browser']);
  });
});
