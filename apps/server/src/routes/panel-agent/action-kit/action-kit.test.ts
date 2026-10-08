import { describe, expect, it } from 'vitest';
import { routeError, stateCard, textWindow } from './action-kit.ts';
import { summaryText } from '../texts/texts.ts';

/**
 * Помощники действий агента панели: окно длинного текста и карточка правки
 * состояния. Оба — общие для десятков действий, поэтому их край проверяется
 * отдельно, а не только через одно действие.
 */
describe('action-kit', () => {
  /**
   * F-235. Окно резалось по единицам UTF-16, и край мог попасть в середину
   * суррогатной пары: эмодзи ломалось в обоих окнах.
   */
  it('textWindow не режет суррогатную пару; окна вместе дают исходный текст', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(5)}`;
    const first = textWindow(text, 0, 10);
    expect(first.text).toBe('a'.repeat(9));
    expect(first.nextOffset).toBe(9);
    const second = textWindow(text, first.nextOffset, 10);
    expect(second.text.startsWith('😀')).toBe(true);
    expect(first.text + second.text).toBe(text);
  });

  /**
   * F-290 (d). Отказ маршрута нёс модели русский `message`; код сообщения —
   * английский идентификатор, он и уходит агенту, когда маршрут его дал.
   */
  it('routeError отдаёт модели код сообщения, а не русский текст', () => {
    const coded = routeError('/api/drafts/x', 404, {
      message: 'Черновика x нет',
      messageCode: 'drafts-missing',
      params: { id: 'x' },
    });
    expect(coded.message).toBe(
      'The panel section «drafts» answered HTTP 404: drafts-missing {"id":"x"}',
    );
    expect(routeError('/api/a', 400, { message: 'plain' }).message).toContain(': plain');
  });

  /**
   * F-236. Карточка бросала «ничего не изменится», когда молчал русский дифф,
   * хотя английская сторона двуязычных данных менялась.
   */
  it('stateCard: пустой ru-дифф при непустом en — карточка, а не отказ', () => {
    const summary = summaryText('summary-group-copy', { name: 'a', copy: 'b' });
    const card = stateCard('state.json: x', { title: 'Шаг' }, { title: 'Шаг' }, summary, [], {
      before: { title: 'Step' },
      after: { title: 'Step two' },
    });
    expect(card.diffEn).toContain('+  "title": "Step two"');
    expect(() => stateCard('state.json: x', { a: 1 }, { a: 1 }, summary)).toThrow(
      /Nothing would change/,
    );
  });
});
