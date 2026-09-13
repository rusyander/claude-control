import type { Deck } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../../lib/zip.ts';
import type { DeckAssets } from './assets.ts';
import { renderDeckPptx } from './pptx.ts';

/**
 * PPTX: файл, который откроет PowerPoint.
 *
 * ЧТО ЭТОТ ТЕСТ ДОКАЗЫВАЕТ, а что нет. Он разбирает собранный файл как ZIP и
 * проверяет, что внутри лежат части OOXML, слайдов столько, сколько в колоде,
 * кириллица и заметки доехали, схема уехала картинкой, а управляющий знак из
 * ответа модели не попал в XML. Он НЕ доказывает, что файл откроется у человека:
 * это умеет только сам PowerPoint, и именно он открывает его в
 * `.agent/tmp/t10-pptx-inspect.ps1` (COM, ответ — слайды, их фигуры и текст
 * заметки) и выгружает слайды в PNG (`t10-pptx-shots.ps1`). Разбор здесь —
 * быстрая сетка на каждый прогон, живая проверка — на приёмку задачи.
 */

const deck: Deck = {
  title: 'Итоги квартала',
  subtitle: 'Отдел продаж',
  slides: [
    {
      title: 'Выручка',
      bullets: ['выручка выросла вдвое', 'средний чек — 12 400 ₽'],
      notes: 'Сказать про два крупных контракта.',
    },
    { title: 'Дальше', bullets: ['нанять двух менеджеров'], notes: '' },
  ],
};

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const assets: DeckAssets = { picture: (id) => (id === 'pic1' ? PIXEL : undefined) };

function slidesXml(bytes: Buffer): string {
  return readZip(bytes)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path))
    .map((entry) => entry.data.toString('utf8'))
    .join('');
}

describe('renderDeckPptx', () => {
  it('собирает ZIP с частями OOXML и слайдом на каждый пункт колоды', async () => {
    const entries = readZip(await renderDeckPptx(deck));
    const paths = entries.map((entry) => entry.path);

    expect(paths).toContain('[Content_Types].xml');
    expect(paths).toContain('ppt/presentation.xml');
    expect(paths).toContain('ppt/slideMasters/slideMaster1.xml');
    // Титул плюс два слайда колоды.
    expect(paths.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(3);
  });

  it('текст слайдов и кириллица доезжают в файл', async () => {
    const slides = slidesXml(await renderDeckPptx(deck));

    expect(slides).toContain('Итоги квартала');
    expect(slides).toContain('выручка выросла вдвое');
    expect(slides).toContain('12 400 ₽');
    // Обложка не нумеруется — как и на странице.
    expect(slides).toContain('1 / 2');
    expect(slides).toContain('2 / 2');
  });

  it('заметка докладчику лежит в заметках файла, а не текстом на слайде', async () => {
    const entries = readZip(await renderDeckPptx(deck));
    const notes = entries
      .filter((entry) => entry.path.startsWith('ppt/notesSlides/'))
      .map((entry) => entry.data.toString('utf8'))
      .join('');

    expect(notes).toContain('Сказать про два крупных контракта.');
    expect(slidesXml(await renderDeckPptx(deck))).not.toContain(
      'Сказать про два крупных контракта.',
    );
  });

  it('колода из одного слайда собирается: пустых мест в файле не остаётся', async () => {
    const bytes = await renderDeckPptx({
      title: 'Одна мысль',
      subtitle: '',
      slides: [{ title: '', bullets: ['и всё'], notes: '' }],
    });
    const paths = readZip(bytes).map((entry) => entry.path);

    expect(paths.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(2);
  });

  it('каждая раскладка доезжает своим содержимым, а пустая — не доезжает вовсе', async () => {
    const slides = slidesXml(
      await renderDeckPptx({
        ...deck,
        slides: [
          { layout: 'section', title: 'Часть первая', bullets: [], notes: '' },
          {
            layout: 'stats',
            title: 'Числа',
            bullets: [],
            notes: '',
            stats: [{ value: '34', label: 'проверки живого свипа' }],
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
          // Раскладка без данных: слайд обязан показать хотя бы заголовок.
          { layout: 'stats', title: 'Пусто', bullets: [], notes: '' },
        ],
      }),
    );

    expect(slides).toContain('Часть первая');
    expect(slides).toContain('34');
    expect(slides).toContain('проверки живого свипа');
    expect(slides).toContain('Стало');
    expect(slides).toContain('Проверка стоит своего пути');
    expect(slides).toContain('— владелец');
    expect(slides).toContain('Пусто');
  });

  it('настроение колоды меняет цвета файла', async () => {
    const indigo = slidesXml(await renderDeckPptx(deck));
    const teal = slidesXml(await renderDeckPptx({ ...deck, accent: 'teal' }));

    expect(indigo).toContain('4F5BD5');
    expect(teal).toContain('0A7D75');
    expect(teal).not.toContain('4F5BD5');
  });

  it('схема уезжает картинкой SVG с запасным PNG — так её видит PowerPoint', async () => {
    const bytes = await renderDeckPptx({
      ...deck,
      slides: [
        {
          layout: 'figure',
          title: 'Схема',
          bullets: [],
          notes: '',
          figure: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
          figureCaption: 'один процесс, один порт',
        },
      ],
    });
    const paths = readZip(bytes).map((entry) => entry.path);

    expect(paths.some((path) => path.endsWith('.svg'))).toBe(true);
    // PowerPoint показывает SVG только вместе с запасным растром рядом.
    expect(slidesXml(bytes)).toContain('svgBlip');
    expect(slidesXml(bytes)).toContain('один процесс, один порт');
  });

  it('картинка слайда вшита байтами; без набора файл собирается без неё', async () => {
    const slide = {
      title: 'С картинкой',
      bullets: ['пункт'],
      notes: '',
      pictureId: 'pic1',
    };
    // Папка `ppt/media/` есть в архиве всегда; считаем ФАЙЛЫ в ней.
    const media = (bytes: Buffer) =>
      readZip(bytes).filter((entry) => /^ppt\/media\/.+/.test(entry.path));

    expect(media(await renderDeckPptx({ ...deck, slides: [slide] }, assets))).toHaveLength(1);
    expect(media(await renderDeckPptx({ ...deck, slides: [slide] }))).toHaveLength(0);
  });

  it('управляющий знак и одинокий суррогат не попадают в XML', async () => {
    const dirty = `Заголовок${String.fromCodePoint(0)}${String.fromCodePoint(0xd800)}хвост`;
    const slides = slidesXml(
      await renderDeckPptx({
        ...deck,
        slides: [{ title: dirty, bullets: [`пункт${String.fromCodePoint(1)}`], notes: dirty }],
      }),
    );

    expect(slides).toContain('Заголовок');
    expect(slides).toContain('хвост');
    expect(slides).not.toContain(String.fromCodePoint(0));
    expect(slides).not.toContain(String.fromCodePoint(1));
    expect(slides).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('общие источники колоды становятся последним слайдом', async () => {
    const bytes = await renderDeckPptx({
      ...deck,
      sources: [{ title: 'Реестр компромиссов', url: 'packages/contracts/src/compromises.ts' }],
    });
    const paths = readZip(bytes).map((entry) => entry.path);
    const slides = slidesXml(bytes);

    expect(paths.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(4);
    expect(slides).toContain('Источники');
    expect(slides).toContain('Реестр компромиссов');
    expect(slides).toContain('3 / 3');
  });
});
