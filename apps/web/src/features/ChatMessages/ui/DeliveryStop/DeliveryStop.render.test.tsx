import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { deliveryStopOf } from '../../lib/deliveryStop';
import type { ChildStageGroup } from '../ChildStages.types';
import { DeliveryStop } from './DeliveryStop';

/**
 * Остановленная на доставке группа сама не продолжит (F-23): ни один путь
 * сервера её не двигает. Карточка из настоящего `deliveryStopOf` по записи,
 * которую пишет конвейер (причина — первым пунктом с кодом, F-23a), обязана
 * сказать человеку, что делать, а не «Панель доводит сама … от вас ничего не нужно».
 */

const GAPS = [
  'сито «интеграция»: нет записи прогона — прогоните интеграционные тесты',
  'незакоммиченные правки: src/a.ts',
];
const REASONS = {
  stalled:
    'напоминание 2 ничего не изменило: та же голова ветки и те же пробелы — посмотрите, что держит группу, и продолжите её словом',
  'nudge-cap':
    'панель напомнила группе 6 раз — это потолок напоминаний; группа двигалась, но не дошла — продолжите её словом',
  'escalation-stalled':
    'разбор доставки на усиленной модели тоже ничего не изменил (после 4 напоминаний): та же голова ветки и те же пробелы — нужен человек',
} as const;

const stopped = (kind: keyof typeof REASONS | undefined): ChildStageGroup => {
  const missing = kind ? [REASONS[kind], ...GAPS] : GAPS;
  return {
    chatId: 'c1',
    title: 'Лимиты',
    stages: ['work'],
    isRunning: false,
    error: `доставка не доведена: ${missing.join('; ')}`,
    errorCode: 'split-delivery-incomplete',
    deliveryMissing: missing,
    ...(kind
      ? {
          deliveryMissingCodes: [
            { messageCode: `split-delivery-${kind}` as never, params: { nudges: 2 } },
            null,
            null,
          ],
        }
      : {}),
  };
};

function render(group: ChildStageGroup): string {
  const stop = deliveryStopOf(group);
  if (!stop) throw new Error('no delivery stop');
  return renderToStaticMarkup(<DeliveryStop stop={stop} />);
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '');
const whoOf = (html: string): string =>
  textOf(html.match(/<span[^>]*data-hub-delivery-who[^>]*>(.*?)<\/span>/)?.[1] ?? '');

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('DeliveryStop — остановленная группа ждёт человека (F-23b)', () => {
  it.each([
    ['stalled', /Напоминание ничего не сдвинуло.*[Пп]родолжите её словом в чате группы/],
    ['nudge-cap', /Потолок напоминаний.*[Пп]родолжите её словом в чате группы/],
    ['escalation-stalled', /тоже ничего не сдвинул — нужен человек/],
    [undefined, /сама она не продолжит.*[Пп]родолжите её словом в чате группы/],
  ] as const)('вид остановки %s — действие человека, без «доводит сама»', async (kind, action) => {
    await i18n.changeLanguage('ru');
    const html = render(stopped(kind));
    const text = textOf(html);

    expect(whoOf(html)).toMatch(action);
    expect(text).toContain('Доставка остановлена — 2 пункта');
    expect(text).not.toMatch(/доводит сама|ничего не нужно|продолжит сама/);
    expect(html).toContain('data-delivery-mode="continue"');
    // Причина — строкой действия, а не пунктом агента: в списке одни пробелы.
    expect([...html.matchAll(/data-hub-delivery-item/g)]).toHaveLength(2);
    expect(html).toContain(`data-delivery-stall="${kind ?? 'none'}"`);
  });

  it('в английском интерфейсе — английские заголовок и действие', async () => {
    await i18n.changeLanguage('en');
    const html = render(stopped('escalation-stalled'));
    const text = textOf(html);

    expect(text).toContain('Delivery stopped — 2 items');
    expect(whoOf(html)).toMatch(/a human is needed.*continue the group with a word in its chat/);
    expect(text).not.toMatch(/finishing it itself|nothing is needed/);
  });

  it('пункт только для человека и причины нет — строки действия нет, режим «человек»', () => {
    const group: ChildStageGroup = {
      ...stopped(undefined),
      deliveryMissing: [GAPS[0] ?? '', 'нужен человек — слияние: ветка готова'],
      deliveryMissingCodes: [
        null,
        { messageCode: 'delivery-human-merge' as never, params: { what: 'ветка готова' } },
      ],
    };
    const html = render(group);

    expect(html).toContain('data-delivery-mode="human"');
    expect(html).not.toContain('data-hub-delivery-who');
    expect(textOf(html)).toContain('Нужен мерж: ветка готова');
  });
});
