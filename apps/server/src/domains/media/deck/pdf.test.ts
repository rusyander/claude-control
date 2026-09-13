import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Deck } from '@agentdeck/contracts';
import { isMediaError } from '../errors.ts';
import { renderDeckHtml } from './html.ts';
import { canPrintPdf, printDeckPdf } from './pdf.ts';

/**
 * PDF: печать системным браузером — и обе ветки обещания.
 *
 * Живая печать ниже — ЕДИНСТВЕННОЕ место, где проверяется вся дорога: что
 * найденный браузер запускается, что страница колоды открывается из файла, что
 * `@page` даёт ровно один лист на слайд и что панель узнаёт итог по подписи.
 * Разбором этого не докажешь, поэтому она и идёт по-настоящему — но только там,
 * где браузер есть; на машине без него это сказано пропуском, а не зелёным.
 *
 * Вторая ветка — «печатать нечем» — важна не меньше: человек должен получить
 * названную причину и работающие HTML с PPTX, а не пустой файл. Её и проверяем
 * подставленным окружением (`MediaDeps.env` заведён ровно для этого).
 */

/**
 * Где ветку «браузера нет» можно создать окружением. На macOS поиск смотрит в
 * фиксированные пути `/Applications`, и спрятать оттуда установленный Chrome
 * окружение не может — там этот случай честно пропускается.
 */
const CAN_HIDE_BROWSER = process.platform !== 'darwin';

const deck: Deck = {
  title: 'Итоги квартала',
  subtitle: 'Отдел продаж',
  slides: [
    { title: 'Выручка', bullets: ['выручка выросла вдвое'], notes: 'вслух' },
    { title: 'Дальше', bullets: ['нанять двух менеджеров'], notes: '' },
  ],
};

/** Листов в напечатанном файле: объекты страниц, а не дерево `/Pages`. */
function pageCount(bytes: Buffer): number {
  return bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
}

describe('canPrintPdf', () => {
  it.skipIf(!CAN_HIDE_BROWSER)('пустое окружение — печатать нечем', () => {
    expect(canPrintPdf({})).toBe(false);
  });

  it('названный в окружении браузер берётся как есть', () => {
    const here = fileURLToPath(import.meta.url);

    // Файл существует и этого достаточно: панель ищет файл, а не спрашивает
    // браузер, умеет ли он печатать. Запуск подставленного пути — уже дело печати.
    expect(canPrintPdf({ AGENTDECK_BROWSER: here })).toBe(true);
    expect(canPrintPdf({ CHROME_PATH: here })).toBe(true);
    expect(canPrintPdf({ AGENTDECK_BROWSER: join(here, 'нет-такого') })).toBe(false);
  });
});

describe('printDeckPdf', () => {
  it.skipIf(!CAN_HIDE_BROWSER)('без браузера — причина словами и названные браузеры', async () => {
    const error = await printDeckPdf(renderDeckHtml(deck), {}).catch((reason: unknown) => reason);

    expect(isMediaError(error)).toBe(true);
    expect((error as Error).message).toContain('Chrome');
    // Человеку сказано, что остальное работает: иначе отказ читается как «колода
    // не собралась вовсе».
    expect((error as Error).message).toContain('PPTX');
  });

  it.skipIf(!canPrintPdf())(
    'живая печать: лист на слайд, и панель узнаёт PDF по подписи',
    async () => {
      const bytes = await printDeckPdf(renderDeckHtml(deck));

      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Титул плюс два слайда: `page-break-after` в странице обязан дать три
      // листа. Разошлось — значит PDF разошёлся с предпросмотром.
      expect(pageCount(bytes)).toBe(3);
    },
    120_000,
  );
});
