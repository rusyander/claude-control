import { describe, it, expect } from 'vitest';
import type { ModelPricing, PricingEntry } from '@claude-control/contracts';
import {
  PRICING_FIELDS,
  draftFromPrice,
  nextCustom,
  overrideFor,
  priceFromDraft,
} from './PricingRow';

/**
 * Регрессия про ДЕНЬГИ. Карточка «Тарифы» правила четыре поля, и часовая ставка
 * записи кэша задать себя не могла вовсе: в прайсе она ОТДЕЛЬНАЯ (в 1.6 раза
 * дороже пятиминутной), почти весь объём записи идёт именно в часовой кэш, а
 * расчёт домножал введённую пятиминутную на 1.6 — набранные $6.25 превращались
 * в счёте в $10, и ни одно поле карточки этого не показывало.
 */

const entry: PricingEntry = {
  id: 'claude-opus-4-8',
  label: 'Claude Opus 4.8',
  price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
};

describe('PRICING_FIELDS', () => {
  it('часовая запись кэша — отдельная колонка, а не производная от пятиминутной', () => {
    expect(PRICING_FIELDS).toEqual(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']);
  });
});

describe('draftFromPrice', () => {
  it('часовая ставка попадает в форму — её можно увидеть и поправить', () => {
    expect(draftFromPrice(entry.price)).toEqual({
      input: '5',
      output: '25',
      cacheRead: '0.5',
      cacheWrite: '6.25',
      cacheWrite1h: '10',
    });
  });

  it('неизвестная часовая ставка даёт пустое поле, а не выдуманное число', () => {
    const price: ModelPricing = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(draftFromPrice(price).cacheWrite1h).toBe('');
  });
});

describe('priceFromDraft', () => {
  it('часовая ставка сохраняется отдельным полем', () => {
    const price = priceFromDraft({
      input: '5',
      output: '25',
      cacheRead: '0.5',
      cacheWrite: '6.25',
      cacheWrite1h: '9',
    });

    expect(price).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      cacheWrite1h: 9,
    });
  });

  it('пустая часовая ставка не превращается в ноль — поле необязательно', () => {
    const price = priceFromDraft({
      input: '5',
      output: '25',
      cacheRead: '0.5',
      cacheWrite: '6.25',
      cacheWrite1h: '  ',
    });

    expect(price).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(price && 'cacheWrite1h' in price).toBe(false);
  });

  it('мусор и отрицательные числа ценой не становятся', () => {
    const base = { input: '5', output: '25', cacheRead: '0.5', cacheWrite: '6.25' };
    expect(priceFromDraft({ ...base, cacheWrite: 'дорого' })).toBeUndefined();
    expect(priceFromDraft({ ...base, cacheWrite1h: '-1' })).toBeUndefined();
    expect(priceFromDraft({ ...base, output: '' })).toBeUndefined();
  });
});

describe('nextCustom', () => {
  it('своя часовая ставка уходит в настройки вместе с остальными', () => {
    const price = priceFromDraft({ ...draftFromPrice(entry.price), cacheWrite1h: '7' });
    expect(price).toBeDefined();
    if (!price) return;

    expect(nextCustom({}, entry, price)['claude-opus-4-8']).toEqual({
      ...entry.price,
      cacheWrite1h: 7,
    });
  });

  it('строка, совпавшая с прайсом целиком, своей ценой не становится', () => {
    // Иначе открытие и сохранение строки без правок навсегда отцепляло бы её от
    // прайса — обновление цен на сайте до неё больше не доходило бы.
    const price = priceFromDraft(draftFromPrice(entry.price));
    expect(price).toBeDefined();
    if (!price) return;

    expect(nextCustom({}, entry, price)).toEqual({});
  });

  it('прежний ключ-фрагмент убирается: две своих цены на одну модель не живут', () => {
    const broad: ModelPricing = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    const price = priceFromDraft({ ...draftFromPrice(entry.price), cacheWrite1h: '7' });
    expect(price).toBeDefined();
    if (!price) return;

    expect(Object.keys(nextCustom({ opus: broad }, entry, price))).toEqual(['claude-opus-4-8']);
  });
});

describe('overrideFor', () => {
  it('находит свою цену по фрагменту имени', () => {
    const own: ModelPricing = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    expect(overrideFor({ opus: own }, 'claude-opus-4-8')).toEqual(own);
    expect(overrideFor({ opus: own }, 'claude-haiku-4-5')).toBeUndefined();
  });
});
