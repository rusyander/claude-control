import { describe, it, expect, beforeEach } from 'vitest';
import {
  unknownTabParam,
  nextPageTab,
  pageTabStorageKey,
  pickPageTab,
  readRememberedPageTab,
  rememberPageTab,
  revealScrollLeft,
  stripScrollDelta,
} from './page-tab';

const IDS = ['proxy', 'rules', 'check'] as const;

describe('pickPageTab', () => {
  it('адрес главнее памяти', () => {
    expect(pickPageTab(IDS, 'check', 'rules')).toBe('check');
  });

  it('без адреса открывается запомненная вкладка', () => {
    expect(pickPageTab(IDS, undefined, 'rules')).toBe('rules');
  });

  it('незнакомое значение в адресе уступает памяти, а не даёт пустой экран', () => {
    expect(pickPageTab(IDS, 'xyz', 'rules')).toBe('rules');
  });

  it('ни адреса, ни памяти — первая вкладка', () => {
    expect(pickPageTab(IDS, 'xyz', 'nope')).toBe('proxy');
    expect(pickPageTab(IDS, undefined, undefined)).toBe('proxy');
  });

  it('не-строка в адресе не принимается за вкладку', () => {
    expect(pickPageTab(IDS, 1, undefined)).toBe('proxy');
  });
});

describe('nextPageTab', () => {
  it('стрелки ходят по соседям и переходят через край', () => {
    expect(nextPageTab(IDS, 'proxy', 'ArrowRight')).toBe('rules');
    expect(nextPageTab(IDS, 'check', 'ArrowRight')).toBe('proxy');
    expect(nextPageTab(IDS, 'proxy', 'ArrowLeft')).toBe('check');
    expect(nextPageTab(IDS, 'rules', 'ArrowUp')).toBe('proxy');
    expect(nextPageTab(IDS, 'rules', 'ArrowDown')).toBe('check');
  });

  it('Home и End — края списка', () => {
    expect(nextPageTab(IDS, 'rules', 'Home')).toBe('proxy');
    expect(nextPageTab(IDS, 'rules', 'End')).toBe('check');
  });

  it('чужая клавиша — не наше событие', () => {
    expect(nextPageTab(IDS, 'rules', 'Enter')).toBeUndefined();
  });
});

describe('память вкладки', () => {
  let map: Map<string, string>;

  beforeEach(() => {
    map = new Map();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string): string | null => map.get(key) ?? null,
      setItem: (key: string, value: string): void => void map.set(key, value),
    };
  });

  it('запомненная вкладка читается обратно, у каждого раздела своя', () => {
    rememberPageTab('dlp', 'rules');
    rememberPageTab('scripts', 'unused');
    expect(readRememberedPageTab('dlp')).toBe('rules');
    expect(readRememberedPageTab('scripts')).toBe('unused');
    expect(map.get(pageTabStorageKey('dlp'))).toBe('rules');
  });

  it('недоступное хранилище не роняет страницу', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (): never => {
        throw new Error('denied');
      },
      setItem: (): never => {
        throw new Error('denied');
      },
    };
    expect(() => rememberPageTab('dlp', 'rules')).not.toThrow();
    expect(readRememberedPageTab('dlp')).toBeUndefined();
  });
});

describe('stripScrollDelta', () => {
  it('полоса прилипла, её место уехало вверх — прокрутить ровно к нему', () => {
    // Место полосы в потоке на 1794 px выше верха области с отступом 32.
    expect(stripScrollDelta(-1794 + 100, 100, 32)).toBe(-1826);
  });

  it('полоса на своём месте или ниже — прокрутку не трогаем', () => {
    expect(stripScrollDelta(132, 100, 32)).toBe(0);
    expect(stripScrollDelta(400, 100, 32)).toBe(0);
  });
});

describe('revealScrollLeft', () => {
  it('вкладка правее видимого — полоса сдвигается, чтобы она встала целиком', () => {
    expect(revealScrollLeft(500, 120, 0, 360)).toBe(268);
  });

  it('вкладка левее видимого — сдвиг к ней с запасом, не меньше нуля', () => {
    expect(revealScrollLeft(40, 100, 200, 360)).toBe(32);
    expect(revealScrollLeft(4, 100, 200, 360)).toBe(0);
  });

  it('вкладка видна — полоса стоит на месте', () => {
    expect(revealScrollLeft(100, 80, 50, 360)).toBe(50);
  });
});

/**
 * `?tab=1` роутер разбирает числом, и разобранный адрес страницы его не несёт.
 * Хук смотрит в сырой адрес: любая `tab`, не равная открытой вкладке, —
 * заменяется ею (F-337).
 */
describe('unknownTabParam', () => {
  it('число, незнакомая строка — заменить; открытая вкладка или нет параметра — нет', () => {
    expect(unknownTabParam(1, 'passport')).toBe(true);
    expect(unknownTabParam('xyz', 'passport')).toBe(true);
    expect(unknownTabParam('passport', 'passport')).toBe(false);
    expect(unknownTabParam(undefined, 'passport')).toBe(false);
  });
});
