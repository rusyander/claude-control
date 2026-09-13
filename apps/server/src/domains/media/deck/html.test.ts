import type { Deck } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import type { DeckAssets } from './assets.ts';
import { renderDeckHtml } from './html.ts';

/**
 * Страница колоды: без сети, без чужой разметки и без пустых слайдов.
 *
 * Здесь заперты обещания, которые человек проверить не может, а сломать легко
 * одной правкой шаблона: в странице НЕТ ни одного адреса наружу (иначе
 * предпросмотр в песочнице молча покажет колоду без шрифтов и без стилей), текст
 * слайдов приезжает из ответа модели ЭКРАНИРОВАННЫМ, заметка докладчику не
 * попадает на лицо слайда, а раскладка, которой нечего показать, уходит в ту, у
 * которой есть.
 *
 * Чего тест НЕ доказывает: что колода красива и что ничего не обрезано. Это
 * видно только на снимках — `.agent/screenshots/before-after/t10-v2-deck/`.
 */

function deck(overrides: Partial<Deck> = {}): Deck {
  return {
    title: 'Итоги квартала',
    subtitle: 'Отдел продаж',
    slides: [
      {
        title: 'Выручка',
        bullets: ['выручка выросла вдвое за квартал', 'средний чек — 12 400 ₽'],
        notes: 'Сказать, что рост дали два крупных контракта.',
      },
      { title: 'Следующий шаг', bullets: ['нанять двух менеджеров'], notes: '' },
    ],
    ...overrides,
  };
}

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const assets: DeckAssets = { picture: (id) => (id === 'pic1' ? PIXEL : undefined) };

describe('renderDeckHtml', () => {
  it('в странице нет ни одного обращения в сеть', () => {
    const html = renderDeckHtml(deck());

    // Ни CDN, ни шрифтов, ни картинок по ссылке — ровно критерий задачи.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\/\/[a-z]/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
  });

  it('движение на странице сделано стилями, а не скриптом', () => {
    const html = renderDeckHtml(deck());

    expect(html).toContain('animation-timeline:view()');
    expect(html).toContain('scroll-snap-type:y proximity');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).not.toMatch(/<script\b/i);
  });

  it('титул плюс слайд на каждый пункт колоды, и номера на месте', () => {
    const html = renderDeckHtml(deck());

    expect(html.match(/<section class="slide/g)).toHaveLength(3);
    // Обложка не нумеруется: номер — это место в рассказе, а не в файле.
    expect(html).toContain('1 / 2');
    expect(html).toContain('2 / 2');
  });

  it('заметка докладчику лежит под слайдом и в печать не идёт', () => {
    const html = renderDeckHtml(deck());

    expect(html).toContain('Сказать, что рост дали два крупных контракта.');
    expect(html.match(/class="notes"/g)).toHaveLength(1);
    // Заметка стоит ПОСЛЕ закрытия слайда, а не внутри него.
    const slideEnd = html.indexOf('</section>');
    expect(html.indexOf('Сказать, что рост дали')).toBeGreaterThan(slideEnd);
    expect(html).toContain('.notes{display:none!important}');
  });

  it('разметка из ответа модели остаётся текстом', () => {
    const html = renderDeckHtml(
      deck({
        title: '<script>alert(1)</script>',
        subtitle: 'кавычка " и амперсанд &',
        slides: [{ title: '<img src=x onerror=alert(1)>', bullets: ['<b>жирный</b>'], notes: '' }],
      }),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>жирный</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;жирный&lt;/b&gt;');
    expect(html).toContain('кавычка &quot; и амперсанд &amp;');
  });

  it('размер страницы объявлен в самой странице — из неё же печатается PDF', () => {
    const html = renderDeckHtml(deck());

    // 13.333in × 7.5in — это 16:9. Без `@page` браузер напечатал бы A4 с полями,
    // и PDF разошёлся бы с тем, что человек видел в предпросмотре.
    expect(html).toMatch(/@page\s*\{\s*size:\s*13\.333in 7\.5in;\s*margin:\s*0\s*\}/);
    expect(html).toContain('page-break-after:always');
  });

  it('колода без подзаголовка не рисует пустую строку под титулом', () => {
    const html = renderDeckHtml(deck({ subtitle: '' }));

    expect(html).not.toContain('class="cover__kicker"');
    expect(html).not.toContain('class="cover__sub"');
  });

  it('каждая раскладка рисует своё содержимое', () => {
    const html = renderDeckHtml(
      deck({
        slides: [
          { layout: 'section', title: 'Часть первая', bullets: [], notes: '' },
          { layout: 'statement', title: 'Один тезис', bullets: [], notes: '' },
          {
            layout: 'stats',
            title: 'Числа',
            bullets: [],
            notes: '',
            stats: [
              { value: '34', label: 'проверки' },
              { value: '12', label: 'компромиссов' },
            ],
          },
          {
            layout: 'columns',
            title: 'Сравнение',
            bullets: [],
            notes: '',
            columns: [
              { title: 'Было', bullets: ['ключ у каждого'] },
              { title: 'Стало', bullets: ['ключ у панели'] },
            ],
          },
          {
            layout: 'quote',
            title: 'Слова',
            bullets: [],
            notes: '',
            quote: { text: 'Проверка стоит своего пути', author: 'владелец' },
          },
        ],
      }),
    );

    expect(html).toContain('slide slide--deep slide--section"');
    expect(html).toContain('class="section__ghost"');
    expect(html).toContain('class="statement__text');
    expect(html).toContain('class="stat__value');
    expect(html).toContain('34');
    expect(html).toContain('class="col col--accent"');
    expect(html).toContain('class="quote__text"');
    expect(html).toContain('&#8212; владелец');
  });

  it('раскладка без своих данных уходит в ту, у которой они есть', () => {
    const html = renderDeckHtml(
      deck({
        slides: [
          // Модель назвала stats, а чисел не прислала: пустой слайд недопустим.
          { layout: 'stats', title: 'Числа', bullets: ['зато есть пункт'], notes: '' },
          { layout: 'quote', title: 'Совсем пусто', bullets: [], notes: '' },
        ],
      }),
    );

    expect(html).toContain('slide--bullets"');
    expect(html).toContain('зато есть пункт');
    expect(html).not.toContain('class="stat__value');
    // Ни пунктов, ни цитаты — остаётся крупный тезис из заголовка.
    expect(html).toContain('slide--statement"');
    expect(html).toContain('Совсем пусто');
  });

  it('настроение колоды меняет цвета страницы', () => {
    const indigo = renderDeckHtml(deck());
    const teal = renderDeckHtml(deck({ accent: 'teal' }));

    expect(indigo).toContain('data-accent="indigo"');
    expect(indigo).toContain('--accent:#4F5BD5');
    expect(teal).toContain('data-accent="teal"');
    expect(teal).toContain('--accent:#0A7D75');
    expect(teal).not.toContain('#4F5BD5');
  });

  it('картинка слайда вшита байтами, а незнакомый идентификатор молча пропущен', () => {
    const withPicture = renderDeckHtml(
      deck({
        slides: [{ title: 'С картинкой', bullets: ['пункт'], notes: '', pictureId: 'pic1' }],
      }),
      assets,
    );
    const missing = renderDeckHtml(
      deck({
        slides: [{ title: 'Без картинки', bullets: ['пункт'], notes: '', pictureId: 'нет' }],
      }),
      assets,
    );

    expect(withPicture).toContain(`src="${PIXEL}"`);
    expect(withPicture).toContain('class="split"');
    expect(missing).not.toContain('<img');
    expect(missing).not.toContain('class="split"');
  });

  it('колода без второго довода собирается — так приходят все прежние колоды', () => {
    const html = renderDeckHtml(
      deck({ slides: [{ title: 'Есть', bullets: ['пункт'], notes: '', pictureId: 'pic1' }] }),
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('Есть');
  });

  it('схема вставлена как есть, а не-схема в том же поле отброшена', () => {
    const figure = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const good = renderDeckHtml(
      deck({ slides: [{ layout: 'figure', title: 'Схема', bullets: [], notes: '', figure }] }),
    );
    const bad = renderDeckHtml(
      deck({
        slides: [
          {
            layout: 'figure',
            title: 'Не схема',
            bullets: ['зато пункт'],
            notes: '',
            figure: '<div onclick="alert(1)">нет</div>',
          },
        ],
      }),
    );

    expect(good).toContain(figure);
    expect(good).toContain('class="fig"');
    expect(bad).not.toContain('onclick');
    expect(bad).toContain('slide--bullets');
  });

  it('источники: сноска на слайде и отдельный слайд в конце', () => {
    const html = renderDeckHtml(
      deck({
        sources: [{ title: 'Реестр', url: 'packages/contracts/src/compromises.ts' }],
        slides: [
          {
            title: 'Со сноской',
            bullets: ['пункт'],
            notes: '',
            sources: [{ title: 'pipeline.ts', url: 'apps/server/pipeline.ts' }],
          },
        ],
      }),
    );

    expect(html).toContain('class="cites"');
    expect(html).toContain('pipeline.ts');
    expect(html).toContain('slide--sources"');
    expect(html).toContain('Источники');
    // Слайд источников считается наравне с остальными.
    expect(html).toContain('2 / 2');
  });

  it('управляющий знак из ответа модели не доезжает до страницы', () => {
    const dirty = `Заголовок${String.fromCodePoint(0)}${String.fromCodePoint(7)}`;
    const html = renderDeckHtml(deck({ slides: [{ title: dirty, bullets: [], notes: '' }] }));

    expect(html).toContain('Заголовок');
    expect(html).not.toContain(String.fromCodePoint(0));
    expect(html).not.toContain(String.fromCodePoint(7));
  });
});
