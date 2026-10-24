import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppSettings } from '@agentdeck/contracts';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { i18n } from '@shared/config/i18n';
import { GroupWatchCard } from './GroupWatchCard';

/**
 * Карточка сторожа групп в настройках (F-74): выключенный сторож порогов не
 * читает — выборы порогов заблокированы и сказано почему; включённый — всё
 * правится. Доставка — текстом про событие подписки, не своим выключателем.
 */
const render = (groupWatch: AppSettings['groupWatch'] | undefined, keepWarm?: boolean): string =>
  renderToStaticMarkup(
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
    />,
  );

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
  it('включённый сторож: все пороги правятся, пометки «выключен» нет', () => {
    const html = render({ ...GROUP_WATCH_DEFAULTS, enabled: true });
    expect(THRESHOLD_COUNT).toBe(40);
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
    expect(field('Тяжёлых проверок за группу (R21)')).toContain('2 раза (по умолчанию)');
    expect(field('Проверка тяжёлая, если идёт дольше (R21)')).toContain('3 мин (по умолчанию)');
  });

  it('выключенный сторож и выключенный тёплый кэш: все 38 порогов заблокированы и сказано почему', () => {
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
