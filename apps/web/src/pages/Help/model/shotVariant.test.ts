import { describe, expect, it } from 'vitest';
import { pickShot, shotFallbackChain, shotLangOf } from './shotVariant';
import type { ShotVariantIndex } from './shotVariant.types';

/**
 * Выбор кадра под тему и язык панели. Ошибка здесь не падает: справка просто
 * показывает светлый снимок на тёмной странице или русский под английской
 * подписью, и заметить это можно только глазами.
 */
const where = { topic: 'chat', scenario: 'basics', frame: '01-empty' };
const file = (name: string, width = 1280) => ({ file: name, width, height: 800 });

const full: ShotVariantIndex = {
  topic: 'chat',
  frames: {
    'basics/01-empty': {
      'light-ru': file('01-empty.png'),
      'light-en': file('01-empty.en.png', 1281),
      'dark-ru': file('01-empty.dark.png', 1282),
      'dark-en': file('01-empty.dark.en.png', 1283),
    },
  },
};

describe('порядок замены варианта', () => {
  it('точный → та же тема другой язык → светлый того же языка → светлый русский', () => {
    expect(shotFallbackChain('dark', 'en')).toEqual(['dark-en', 'dark-ru', 'light-en', 'light-ru']);
    expect(shotFallbackChain('dark', 'ru')).toEqual(['dark-ru', 'dark-en', 'light-ru']);
    expect(shotFallbackChain('light', 'en')).toEqual(['light-en', 'light-ru']);
    expect(shotFallbackChain('light', 'ru')).toEqual(['light-ru', 'light-en']);
  });

  it('язык панели сводится к языку кадра', () => {
    expect(shotLangOf('en-US')).toBe('en');
    expect(shotLangOf('ru')).toBe('ru');
    expect(shotLangOf('de')).toBe('ru');
  });
});

describe('выбор файла', () => {
  it('все четыре варианта сняты — берётся ровно свой, с размером', () => {
    expect(pickShot(full, where, 'light', 'ru')).toEqual({
      src: '/help/chat/basics/01-empty.png',
      variant: 'light-ru',
      width: 1280,
      height: 800,
    });
    expect(pickShot(full, where, 'light', 'en').src).toBe('/help/chat/basics/01-empty.en.png');
    expect(pickShot(full, where, 'dark', 'ru').src).toBe('/help/chat/basics/01-empty.dark.png');
    expect(pickShot(full, where, 'dark', 'en')).toMatchObject({
      src: '/help/chat/basics/01-empty.dark.en.png',
      width: 1283,
    });
  });

  it('тёмного английского нет — тёмный русский раньше светлого английского', () => {
    const index: ShotVariantIndex = {
      topic: 'chat',
      frames: {
        'basics/01-empty': {
          'light-ru': file('01-empty.png'),
          'light-en': file('01-empty.en.png'),
          'dark-ru': file('01-empty.dark.png'),
        },
      },
    };
    expect(pickShot(index, where, 'dark', 'en').variant).toBe('dark-ru');
  });

  it('тёмных нет — светлый того же языка, затем светлый русский', () => {
    const index: ShotVariantIndex = {
      topic: 'chat',
      frames: {
        'basics/01-empty': {
          'light-ru': file('01-empty.png'),
          'light-en': file('01-empty.en.png'),
        },
      },
    };
    expect(pickShot(index, where, 'dark', 'en').variant).toBe('light-en');
    const ruOnly: ShotVariantIndex = {
      topic: 'chat',
      frames: { 'basics/01-empty': { 'light-ru': file('01-empty.png') } },
    };
    expect(pickShot(ruOnly, where, 'dark', 'en').variant).toBe('light-ru');
  });

  it('описи нет или кадра в ней нет — исходный файл без размера', () => {
    expect(pickShot(undefined, where, 'dark', 'en')).toEqual({
      src: '/help/chat/basics/01-empty.png',
      variant: 'light-ru',
    });
    expect(pickShot(full, { ...where, frame: '02-other' }, 'dark', 'en').src).toBe(
      '/help/chat/basics/02-other.png',
    );
  });
});
