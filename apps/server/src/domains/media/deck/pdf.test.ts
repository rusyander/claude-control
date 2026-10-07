import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Deck } from '@agentdeck/contracts';
import { isMediaError } from '../errors.ts';
import { renderDeckHtml } from './html.ts';
import { canPrintPdf, dropPrintDir, printDeckPdf } from './pdf.ts';

const printDirs = (): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('cc-deck-'));

describe('dropPrintDir', () => {
  it('занятый каталог сносится повтором в фоне, а не остаётся в temp', () => {
    vi.useFakeTimers();
    try {
      let busy = 2;
      const removed: string[] = [];
      const remove = (target: string): void => {
        if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        removed.push(target);
      };

      dropPrintDir('X', [2_000, 10_000, 60_000], remove);
      expect(removed).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(removed).toEqual([]);
      vi.advanceTimersByTime(10_000);
      expect(removed).toEqual(['X']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('повторы конечны: занятый навсегда каталог не крутит таймеры вечно', () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      dropPrintDir('X', [1, 2], () => {
        calls += 1;
        throw new Error('EBUSY');
      });
      vi.advanceTimersByTime(1_000);
      expect(calls).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
      const before = new Set(printDirs());
      const bytes = await printDeckPdf(renderDeckHtml(deck));

      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Титул плюс два слайда: `page-break-after` в странице обязан дать три
      // листа. Разошлось — значит PDF разошёлся с предпросмотром.
      expect(pageCount(bytes)).toBe(3);

      // Отделившийся браузер держит профиль после печати — каталог печати всё
      // равно уходит из temp, пусть и не сразу (фоновые повторы уборки).
      const left = (): string[] => printDirs().filter((name) => !before.has(name));
      for (let waited = 0; left().length > 0 && waited < 20_000; waited += 500) await sleep(500);
      expect(left()).toEqual([]);
    },
    120_000,
  );
});
