import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppSettings } from '@agentdeck/contracts';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupWatchCoverageSummary,
} from '@agentdeck/contracts/group-watch';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { GroupWatchCard } from './GroupWatchCard';

/**
 * Карточка сторожа групп в настройках (F-74): выключенный сторож порогов не
 * читает — выборы порогов заблокированы и сказано почему; включённый — всё
 * правится. Доставка — текстом про событие подписки, не своим выключателем.
 */
const render = (
  groupWatch: AppSettings['groupWatch'] | undefined,
  keepWarm?: boolean,
  coverage?: GroupWatchCoverageSummary,
): string => {
  // Ответ охвата — в кэше запроса, как его положил бы `useGroupWatchCoverage`; нет — строки нет.
  const client = new QueryClient();
  if (coverage) client.setQueryData(queryKeys.groupWatchCoverage, coverage);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GroupWatchCard
        settings={
          {
            groupWatch,
            ...(keepWarm === undefined
              ? {}
              : { groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, keepWarm } }),
          } as AppSettings
        }
        patch={() => undefined}
      />
    </QueryClientProvider>,
  );
};

const selects = (html: string): string[] => [...html.matchAll(/<select[^>]*>/g)].map((m) => m[0]);

/** Тег `<select>` поля с этой подписью — первый после неё. */
const fieldSelect = (html: string, label: string): string => {
  const at = html.indexOf(label);
  expect(at).toBeGreaterThan(-1);
  return /<select[^>]*>/.exec(html.slice(at))?.[0] ?? '';
};
const COLD_LABEL = 'Окно, с которого остывший кэш — потеря (R2)';
/** Каждый числовой порог настроек — своё поле; новый порог без поля карточки краснит счёт. */
const THRESHOLD_COUNT = Object.values(GROUP_WATCH_DEFAULTS).filter(
  (value) => typeof value === 'number',
).length;
const SINGLE_LABEL = 'Следить и за одиночными чатами';
/** Тег переключателя рядом с этой подписью: `aria-label` у Radix-кнопки равен подписи. */
const toggleTag = (html: string, label: string): string =>
  new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('GroupWatchCard', () => {
  it('охват: счёт живых групп по источникам и пробелы с молчащими правилами; ответа нет — строки нет', () => {
    const coverage: GroupWatchCoverageSummary = {
      groups: { stream: 2, transcript: 1, 'text-only': 1, blind: 0 },
      gaps: ['devWatch', 'transcript'],
    };
    const html = render(GROUP_WATCH_DEFAULTS, undefined, coverage);
    expect(html).toContain('data-group-watch-coverage');
    expect(html).toContain(
      'Охват сейчас: Живые группы: поток — 2, транскрипт — 1, только текст — 1. Нет dev-watch, переписки CLI:',
    );
    expect(html).toContain('R38 и R39 молчат');
    expect(html).toContain('правила вызовов молчат');
    expect(render(GROUP_WATCH_DEFAULTS)).not.toContain('data-group-watch-coverage');
    const full = render(GROUP_WATCH_DEFAULTS, undefined, {
      groups: { stream: 0, transcript: 0, 'text-only': 0, blind: 0 },
      gaps: [],
    });
    expect(full).toContain('Охват сейчас: Живых групп сейчас нет. Все источники на месте.');
    const off = render({ ...GROUP_WATCH_DEFAULTS, enabled: false }, undefined, {
      groups: { stream: 0, transcript: 0, 'text-only': 0, blind: 3 },
      gaps: [],
    });
    expect(off).toContain('Сторож выключен — живые группы он не видит (3).');
    expect(off).not.toContain('Все источники на месте');
  });

  it('включённый сторож: все пороги правятся, пометки «выключен» нет', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    expect(THRESHOLD_COUNT).toBe(49);
    expect(selects(html)).toHaveLength(THRESHOLD_COUNT);
    expect(selects(html).filter((tag) => tag.includes('disabled'))).toEqual([]);
    expect(html).not.toContain('data-group-watch-off');
    expect(html).toContain('отмечено событие «Сигнал сторожа групп»');
  });

  it('пороги R13–R19: знаки и токены — в тысячах, запуски — со своей формой слова', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    expect(html).toContain('6 запусков (по умолчанию)');
    expect(html).toContain('4 запуска');
    expect(html).toContain('8 тыс. знаков (по умолчанию)');
    expect(html).toContain('20 тыс. знаков (по умолчанию)');
    expect(html).toContain('90 тыс. токенов (по умолчанию)');
    expect(html).toContain('20 ед. окна (по умолчанию)');
  });

  it('пороги R21: тяжёлых проверок за группу и с какой длительности проверка тяжёлая', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    const field = (label: string): string => {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf('</select>', at));
    };
    expect(field('Проходов тяжёлых проверок за группу (R21)')).toContain('2 раза (по умолчанию)');
    expect(field('Проверка тяжёлая, если идёт дольше (R21)')).toContain('3 мин (по умолчанию)');
  });

  it('пороги перенесённых правил: секунды, тысячи знаков, миллионы токенов, проценты окна', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    const field = (label: string): string => {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf('</select>', at));
    };
    expect(field('Кончившийся вызов шёл дольше (R16)')).toContain('120 с (по умолчанию)');
    expect(field('Фоновая задача открыта дольше (R16)')).toContain('10 мин (по умолчанию)');
    expect(field('Вводная хода группы длиннее (R37)')).toContain('15 тыс. знаков (по умолчанию)');
    expect(field('Перезапусков сервера панели за час')).toContain('3 раза (по умолчанию)');
    expect(field('Прогон сдвинул пятичасовое окно на (R42)')).toContain('5 % (по умолчанию)');
    expect(field('Прогон сдвинул недельное окно на (R42)')).toContain('2 % (по умолчанию)');
    expect(field('Прогон съел токенов больше (R42)')).toContain('3 млн токенов (по умолчанию)');
    expect(field('человеку ничего не ждёт, дольше (R43)')).toContain('60 мин (по умолчанию)');
    // Рост окна посреди сессии (R19): тысячи токенов, свой выбор рядом с заводским.
    const growth = field('Окно сессии выросло над первым запросом на (R19)');
    expect(growth).toContain('100 тыс. токенов (по умолчанию)');
    expect(growth).toContain('60 тыс. токенов');
    expect(growth).toContain('150 тыс. токенов');
  });

  it('выключенный сторож и выключенный тёплый кэш: все пороги заблокированы и сказано почему', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: false }, false);
    expect(selects(html).filter((tag) => tag.includes('disabled'))).toHaveLength(THRESHOLD_COUNT);
    expect(html).toContain('data-group-watch-off');
    expect(html).toContain('Сторож выключен — пороги ниже не действуют');
    expect(html).not.toContain('пинг тёплого кэша');
  });

  it('выключенный сторож при включённом тёплом кэше: окно остывшего кэша правится — по нему решает пинг', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: false }, true);
    expect(fieldSelect(html, COLD_LABEL)).not.toContain('disabled');
    expect(selects(html).filter((tag) => tag.includes('disabled'))).toHaveLength(
      THRESHOLD_COUNT - 1,
    );
    expect(html).toContain(
      'Сторож выключен — пороги ниже не действуют, кроме окна остывшего кэша: его читает пинг тёплого кэша',
    );
    expect(html).toContain('Этот же порог читает пинг тёплого кэша: окно меньше — пинга нет.');
  });

  it('старые настройки без рычагов экономии: тёплый кэш по умолчанию включён — окно не заблокировано', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: false });
    expect(fieldSelect(html, COLD_LABEL)).not.toContain('disabled');
  });

  it('включённый сторож и тёплый кэш: у окна остывшего кэша сказано, что его читает и пинг', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true }, true);
    expect(html).toContain('Этот же порог читает пинг тёплого кэша');
    expect(render({ ...GROUP_WATCH_DEFAULTS, enabled: true }, false)).not.toContain(
      'пинг тёплого кэша',
    );
  });

  it('одиночные чаты: свой переключатель, без сторожа заблокирован, состояние из настроек', () => {
    const on = render({ ...GROUP_WATCH_DEFAULTS, enabled: true, singleChats: true });
    expect(on).toContain(SINGLE_LABEL);
    expect(on).toContain('в Telegram и вебхук уходит только тревога');
    expect(toggleTag(on, SINGLE_LABEL)).toContain('aria-checked="true"');
    expect(toggleTag(on, SINGLE_LABEL)).not.toContain('disabled');
    const off = render({ ...GROUP_WATCH_DEFAULTS, enabled: true, singleChats: false });
    expect(toggleTag(off, SINGLE_LABEL)).toContain('aria-checked="false"');
    const watchOff = render({ ...GROUP_WATCH_DEFAULTS, enabled: false });
    expect(toggleTag(watchOff, SINGLE_LABEL)).toContain('disabled');
    expect(toggleTag(watchOff, 'Сторож включён')).not.toContain('disabled');
  });

  it('пауза сторожа (F1): по умолчанию выключена, без сторожа заблокирована, состояние из настроек', () => {
    const PAUSE_LABEL = 'Ставить группу на паузу на конце хода';
    const byDefault = render(undefined);
    expect(byDefault).toContain(PAUSE_LABEL);
    expect(toggleTag(byDefault, PAUSE_LABEL)).toContain('aria-checked="false"');
    expect(toggleTag(byDefault, PAUSE_LABEL)).not.toContain('disabled');
    const on = render({ ...GROUP_WATCH_DEFAULTS, enabled: true, autoPause: true });
    expect(toggleTag(on, PAUSE_LABEL)).toContain('aria-checked="true"');
    const watchOff = render({ ...GROUP_WATCH_DEFAULTS, enabled: false, autoPause: true });
    expect(toggleTag(watchOff, PAUSE_LABEL)).toContain('disabled');
  });

  it('новые пороги R22–R33: поля с заводскими значениями и формой слова «группы»', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    const field = (label: string): string => {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf('</select>', at));
    };
    expect(field('Одна беда сразу в группах плана (R23)')).toContain('2 группы (по умолчанию)');
    expect(field('Одна беда сразу в группах плана (R23)')).toContain('4 группы');
    expect(field('Служебные вставки CLI больше (R32)')).toContain('20 тыс. знаков (по умолчанию)');
  });

  it('пороги R34 и R35: запись окна в тысячах токенов, файлы — со своей формой слова', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    const field = (label: string): string => {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf('</select>', at));
    };
    const fresh = field('Новый разговор поверх тёплого записал заново больше (R34)');
    expect(fresh).toContain('50 тыс. токенов (по умолчанию)');
    expect(fresh).toContain('100 тыс. токенов');
    const redo = field('Переделанных закоммиченных файлов (R35)');
    expect(redo).toContain('2 файла (по умолчанию)');
    expect(redo).toContain('1 файл');
    expect(redo).toContain('5 файлов');
  });

  it('старые настройки без блока — заводские значения, сторож включён', () => {
    const html = render(undefined);
    expect(selects(html).filter((tag) => tag.includes('disabled'))).toEqual([]);
    expect(html).toContain('20 мин (по умолчанию)');
  });
});
